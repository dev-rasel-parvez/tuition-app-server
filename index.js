const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");
const port =  process.env.PORT || 3000;

// ------------------------------
// FIREBASE ADMIN INIT
// ------------------------------
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// ------------------------------
// MIDDLEWARE
// ------------------------------
app.use(cors());
app.use(express.json());

const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decodedUser = await admin.auth().verifyIdToken(token);
        req.decoded = decodedUser;
        next();
    } catch (error) {
        return res.status(401).send({ message: "Invalid token" });
    }
};


// SUPER ADMIN EMAIL
const SUPER_ADMIN_EMAIL = "projects@resultdrivenads.com";

// ------------------------------
// MONGODB CONNECTION
// ------------------------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xxdkad5.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// -------------------------------------------------------
// AUTO TUITION ID
// -------------------------------------------------------
async function getNextTuitionId(db) {
    const result = await db.collection("counters").findOneAndUpdate(
        { _id: "tuitionId" },
        { $inc: { sequence_value: 1 } },
        { returnDocument: "after", upsert: true }
    );

    return "T" + result.sequence_value.toString().padStart(4, "0");
}

async function run() {
    try {
        await client.connect();
        console.log("Connected to MongoDB!");

        const db = client.db("eTuitionBd");
        const userCollection = db.collection("users");
        const tuitionCollection = db.collection("tuitions");
        const paymentCollection = db.collection("payments");
        const applicationCollection = db.collection("applications");


        // =====================================================
        // BASIC TEST
        // =====================================================
        app.get("/", (req, res) => {
            res.send("Server running");
        });

        // =====================================================
        // USERS
        // =====================================================
        app.post("/users", verifyFirebaseToken, async (req, res) => {
            const user = req.body;

            if (req.decoded.email !== user.email) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            const exists = await userCollection.findOne({ email: user.email });
            if (exists) return res.send({ message: "User already exists" });

            if (user.email === SUPER_ADMIN_EMAIL) {
                user.role = "admin";
                user.status = "approved";
            } else if (user.role === "admin") {
                user.status = "pending";
            } else {
                user.status = "approved";
            }

            user.createdAt = new Date();
            await userCollection.insertOne(user);
            res.send({ success: true });
        });

        app.get("/users/:email/role", async (req, res) => {
            const user = await userCollection.findOne(
                { email: req.params.email },
                { projection: { role: 1, status: 1 } }
            );

            if (!user) return res.send({ role: null, status: null });
            res.send({ role: user.role, status: user.status });
        });

        // GET profile (logged-in user)
        app.get("/profile", verifyFirebaseToken, async (req, res) => {
            const user = await userCollection.findOne(
                { email: req.decoded.email },
                { projection: { password: 0 } }
            );

            if (!user) return res.status(404).send({ message: "User not found" });
            res.send(user);
        });

        app.patch("/profile", verifyFirebaseToken, async (req, res) => {
            try {
                const { name, email, phone, photoURL } = req.body;
                const currentEmail = req.decoded.email;

                const currentUser = await userCollection.findOne({ email: currentEmail });
                if (!currentUser) {
                    return res.status(404).send({ message: "User not found" });
                }

                // ✅ Email uniqueness check
                if (email && email !== currentEmail) {
                    const exists = await userCollection.findOne({ email });
                    if (exists) {
                        return res.status(409).send({ message: "Email already exists" });
                    }
                }

                await userCollection.updateOne(
                    { _id: currentUser._id },
                    {
                        $set: {
                            name,
                            email,
                            phone,
                            photoURL, // ✅ THIS WAS MISSING
                            updatedAt: new Date(),
                        },
                    }
                );

                res.send({ success: true });

            } catch (error) {
                console.error("PROFILE UPDATE ERROR:", error);
                res.status(500).send({ message: "Failed to update profile" });
            }
        });


        // =====================================================
        // ADMIN – USER MANAGEMENT (PAGINATED)
        // =====================================================
        app.get("/admin/users", verifyFirebaseToken, async (req, res) => {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 15;
            const skip = (page - 1) * limit;

            const total = await userCollection.countDocuments();

            const users = await userCollection
                .find()
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({ total, page, limit, users });
        });

        app.patch("/admin/approve/:id", async (req, res) => {
            await userCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: "approved" } }
            );
            res.send({ approved: true });
        });

        app.patch("/admin/user/:id", async (req, res) => {
            await userCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: req.body }
            );
            res.send({ updated: true });
        });

        app.delete("/admin/user/:id", async (req, res) => {
            await userCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send({ deleted: true });
        });

        app.get("/admin/tuitions/:id", verifyFirebaseToken, async (req, res) => {
            try {
                const { id } = req.params;

                // 1️⃣ Get tuition by ObjectId
                const tuition = await tuitionCollection.findOne({
                    _id: new ObjectId(id),
                });

                if (!tuition) {
                    return res.status(404).send({ message: "Tuition not found" });
                }

                // 2️⃣ Get posted student info
                const postedUser = await userCollection.findOne({
                    email: tuition.postedByEmail,
                });

                // 3️⃣ 🔥 GET ALL APPLICATIONS FOR THIS TUITION
                const applications = await applicationCollection
                    .find({ tuitionObjectId: new ObjectId(id) })
                    .toArray();

                // 4️⃣ Return full response
                res.send({
                    tuition: {
                        ...tuition,
                        postedBy: postedUser
                            ? {
                                name: postedUser.name,
                                email: postedUser.email,
                                phone: postedUser.phone,
                                photoURL: postedUser.photoURL,
                            }
                            : null,
                    },
                    applications,
                });

            } catch (error) {
                console.error("Admin tuition details error:", error);
                res.status(500).send({ message: "Failed to load tuition details" });
            }
        });


        app.post("/tuitions", verifyFirebaseToken, async (req, res) => {
            try {
                const data = req.body;

                // 🔐 Auth user email
                const email = req.decoded.email;

                // 🔎 Fetch user from DB
                const user = await userCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                // 🆔 Generate tuition ID
                const tuitionId = await getNextTuitionId(db);

                const tuitionData = {
                    ...data,

                    tuitionId,
                    status: "pending",
                    createdAt: new Date(),

                    // ✅ SAFE USER INFO
                    postedByEmail: email,
                    postedByName: user.name,
                    postedByRole: user.role || "student",
                };

                const result = await tuitionCollection.insertOne(tuitionData);

                res.send({
                    insertedId: result.insertedId,
                    tuitionId,
                });

            } catch (error) {
                console.error("Tuition post error:", error);
                res.status(500).send({ message: "Failed to post tuition" });
            }
        });



        app.get("/tuitions", async (req, res) => {
            const limit = parseInt(req.query.limit) || 12;
            const page = parseInt(req.query.page) || 1;
            const skip = (page - 1) * limit;

            let filters = {};
            const regexField = field => ({ $regex: req.query[field], $options: "i" });

            if (req.query.class) filters.class = regexField("class");
            if (req.query.subjects) filters.subjects = regexField("subjects");
            if (req.query.university) filters.university = regexField("university");
            if (req.query.uniSubject) filters.uniSubject = regexField("uniSubject");
            if (req.query.location) filters.location = regexField("location");
            if (req.query.schedule) filters.schedule = regexField("schedule");

            // ❗ Tutors only see approved tuitions
            filters.status = "approved";

            const total = await tuitionCollection.countDocuments(filters);

            const tuitions = await tuitionCollection
                .find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({ total, tuitions });
        });


        // =======================================
        // PUBLIC – TUITION DETAILS (by tuitionId)
        // =======================================

        app.get("/tuitions/:tuitionId", async (req, res) => {
            const { tuitionId } = req.params;

            const tuition = await tuitionCollection.findOne({ tuitionId });

            if (!tuition) {
                return res.status(404).send({ message: "Tuition not found" });
            }

            res.send(tuition);
        });


        // =====================================================
        // TUTOR – MY APPLICATIONS
        // =====================================================
        app.get("/tutor/my-applications", verifyFirebaseToken, async (req, res) => {
            try {
                const tutor = await userCollection.findOne({
                    email: req.decoded.email,
                    role: "tutor",
                });

                if (!tutor) {
                    return res.status(403).send({ message: "Tutor only" });
                }

                const applications = await applicationCollection.aggregate([
                    { $match: { tutorId: tutor._id } },
                    {
                        $lookup: {
                            from: "tuitions",
                            localField: "tuitionObjectId",
                            foreignField: "_id",
                            as: "tuition",
                        },
                    },
                    { $unwind: "$tuition" },
                    { $sort: { createdAt: -1 } },
                ]).toArray();

                res.send(applications);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to load applications" });
            }
        });



        // =====================================================
        // TUTOR – WITHDRAW APPLICATION (FIXED)
        // =====================================================
        app.delete("/tutor/applications/:id",
            verifyFirebaseToken,
            async (req, res) => {
                try {
                    const appId = req.params.id;

                    const tutor = await userCollection.findOne({
                        email: req.decoded.email,
                        role: "tutor",
                    });

                    if (!tutor) {
                        return res.status(403).send({ message: "Tutor only" });
                    }

                    const application = await applicationCollection.findOne({
                        _id: new ObjectId(appId),
                        tutorId: tutor._id,
                        status: "pending",
                    });

                    if (!application) {
                        return res
                            .status(404)
                            .send({ message: "Application not found or cannot withdraw" });
                    }

                    await applicationCollection.deleteOne({
                        _id: new ObjectId(appId),
                    });

                    res.send({ withdrawn: true });

                } catch (err) {
                    console.error("Withdraw error:", err);
                    res.status(500).send({ message: "Withdraw failed" });
                }
            }
        );


        // ACCEPT
        app.patch("/student/applications/:id/accept", verifyFirebaseToken, async (req, res) => {
            await applicationCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: "accepted" } }
            );
            res.send({ accepted: true });
        });

        // REJECT
        app.patch("/student/applications/:id/reject", verifyFirebaseToken, async (req, res) => {
            await applicationCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: "rejected" } }
            );
            res.send({ rejected: true });
        });


        // =====================================================
        // TUTOR – EDIT APPLICATION
        // =====================================================
        app.patch("/tutor/applications/:id",
            verifyFirebaseToken,
            async (req, res) => {
                try {
                    const appId = req.params.id;
                    const { experience, expectedSalary } = req.body;

                    const tutor = await userCollection.findOne({
                        email: req.decoded.email,
                        role: "tutor",
                    });

                    if (!tutor) {
                        return res.status(403).send({ message: "Tutor only" });
                    }

                    const application = await applicationCollection.findOne({
                        _id: new ObjectId(appId),
                        tutorId: tutor._id,
                        status: "pending",
                    });

                    if (!application) {
                        return res
                            .status(404)
                            .send({ message: "Application not found or locked" });
                    }

                    await applicationCollection.updateOne(
                        { _id: new ObjectId(appId) },
                        {
                            $set: {
                                "tutor.experience": experience,
                                "tutor.expectedSalary": expectedSalary,
                                updatedAt: new Date(),
                            },
                        }
                    );

                    res.send({ updated: true });
                } catch (err) {
                    console.error(err);
                    res.status(500).send({ message: "Update failed" });
                }
            }
        );


        // =====================================================
        // STUDENT – MY TUITIONS WITH APPLICATIONS
        // =====================================================

        app.get("/my-tuitions/:email", verifyFirebaseToken, async (req, res) => {
            const email = req.params.email;

            if (req.decoded.email !== email) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            const tuitions = await tuitionCollection.aggregate([
                {
                    $match: {
                        postedByEmail: email,
                        postedByRole: "student"
                    }
                },
                { $sort: { createdAt: -1 } },
                {
                    $lookup: {
                        from: "applications",
                        localField: "tuitionId",
                        foreignField: "tuitionId",
                        as: "applications"
                    }
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "applications.tutorId",
                        foreignField: "_id",
                        as: "tutors"
                    }
                }
            ]).toArray();

            res.send(tuitions);
        });

        app.patch("/tuitions/:id", verifyFirebaseToken, async (req, res) => {
            await tuitionCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: req.body }
            );
            res.send({ updated: true });
        });



        app.delete("/tuitions/:id", verifyFirebaseToken, async (req, res) => {
            await tuitionCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send({ deleted: true });
        });



        app.post("/tuitions/:tuitionId/apply", verifyFirebaseToken, async (req, res) => {
            try {
                const { tuitionId } = req.params;
                const email = req.decoded.email;

                const tutor = await userCollection.findOne({
                    email,
                    role: "tutor",
                    status: "approved",
                });

                if (!tutor) {
                    return res.status(403).send({ message: "Only tutors can apply" });
                }

                const tuition = await tuitionCollection.findOne({ tuitionId });
                if (!tuition) {
                    return res.status(404).send({ message: "Tuition not found" });
                }

                const exists = await applicationCollection.findOne({
                    tuitionId,
                    tutorId: tutor._id,
                });

                if (exists) {
                    return res.send({ applied: false, message: "Already applied" });
                }

                // 🔥 SERIAL NUMBER
                const count = await applicationCollection.countDocuments({ tuitionId });

                const application = {
                    tuitionId,
                    tuitionObjectId: tuition._id,
                    tutorId: tutor._id,
                    serial: count + 1,

                    tutor: {
                        name: tutor.name,
                        email: tutor.email,
                        contactPhone: tutor.contactPhone || tutor.phone, // ✅ FIX
                        photoURL: tutor.photoURL,
                        ssc: tutor.ssc,
                        hsc: tutor.hsc,
                        university: tutor.university,
                        department: tutor.department,
                        experience: req.body.experience,
                        expectedSalary: req.body.expectedSalary,
                    },

                    status: "pending",
                    createdAt: new Date(),
                };


                await applicationCollection.insertOne(application);

                res.send({ applied: true });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Apply failed" });
            }
        });


        app.get("/tuitions/:id/applications",
            verifyFirebaseToken,
            async (req, res) => {
                try {
                    const tuitionObjectId = new ObjectId(req.params.id);

                    const applications = await applicationCollection
                        .find({ tuitionObjectId })
                        .sort({ "tutor.serial": 1 })
                        .toArray();

                    res.send(applications);
                } catch (err) {
                    console.error("Analytics load error:", err);
                    res.status(500).send({ message: "Failed to load applications" });
                }
            }
        );



        app.get("/tuitions/:tuitionId/applications", verifyFirebaseToken, async (req, res) => {
            try {
                const { tuitionId } = req.params;

                const applications = await applicationCollection
                    .find({ tuitionId })
                    .sort({ serial: 1 })
                    .toArray();

                res.send(applications);
            } catch (err) {
                res.status(500).send({ message: "Failed to load applications" });
            }
        });




        // PUBLIC – APPROVED TUTORS LIST (PAGINATED + FILTER)
        // =====================================================
        app.get("/tutors", async (req, res) => {
            const limit = parseInt(req.query.limit) || 12;
            const page = parseInt(req.query.page) || 1;
            const skip = (page - 1) * limit;

            let filters = {
                role: "tutor",
                status: "approved"
            };

            const regexField = field => ({
                $regex: req.query[field],
                $options: "i"
            });

            if (req.query.university) filters.university = regexField("university");
            if (req.query.department) filters.department = regexField("department");
            if (req.query.experience) filters.experience = regexField("experience");
            if (req.query.runningYear) filters.runningYear = regexField("runningYear");
            if (req.query.ssc) filters.ssc = regexField("ssc");
            if (req.query.hsc) filters.hsc = regexField("hsc");

            const total = await userCollection.countDocuments(filters);

            const tutors = await userCollection
                .find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({ total, tutors });
        });


        app.get("/tutors/details/:id", verifyFirebaseToken, async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid tutor ID" });
                }

                const tutor = await userCollection.findOne(
                    {
                        _id: new ObjectId(id),
                        role: "tutor",
                        status: "approved"
                    },
                    {
                        projection: {
                            password: 0
                        }
                    }
                );

                if (!tutor) {
                    return res.status(404).send({ message: "Tutor not found" });
                }

                res.send({ tutor });

            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });



        // ADMIN – TUITION MANAGEMENT (NEW)
        // =====================================================
        app.get("/admin/tuitions", verifyFirebaseToken, async (req, res) => {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 15;
            const skip = (page - 1) * limit;

            const total = await tuitionCollection.countDocuments();

            const tuitions = await tuitionCollection
                .find()
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({ total, page, limit, tuitions });
        });

        app.patch("/admin/tuitions/:id/status", verifyFirebaseToken, async (req, res) => {
            const { status, rejectReason } = req.body;

            await tuitionCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                {
                    $set: {
                        status,
                        rejectReason: rejectReason || null
                    }
                }
            );

            res.send({ updated: true });
        });

        // =====================================================
        // Payments

        app.post("/payments/create-intent", verifyFirebaseToken, async (req, res) => {
            try {
                const { amount } = req.body;

                if (!amount || amount <= 0) {
                    return res.status(400).send({ message: "Invalid amount" });
                }

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount * 100, // 🔥 Stripe uses cents
                    currency: "bdt",
                    payment_method_types: ["card"],
                });

                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (err) {
                res.status(500).send({ message: "Failed to create payment intent" });
            }
        });


        app.post("/payments/confirm", verifyFirebaseToken, async (req, res) => {
            try {
                const { applicationId, paymentIntentId, amount } = req.body;

                // 1️⃣ Find application
                const application = await applicationCollection.findOne({
                    _id: new ObjectId(applicationId),
                });

                if (!application) {
                    return res.status(404).send({ message: "Application not found" });
                }

                // 2️⃣ Approve selected application
                await applicationCollection.updateOne(
                    { _id: application._id },
                    {
                        $set: {
                            status: "approved",
                            paidAt: new Date(),
                            paymentIntentId,
                            amount,
                        },
                    }
                );

                // 3️⃣ Reject other applications of same tuition
                await applicationCollection.updateMany(
                    {
                        tuitionId: application.tuitionId,
                        _id: { $ne: application._id },
                    },
                    { $set: { status: "rejected" } }
                );

                // 🔥🔥🔥 4️⃣ INSERT INTO paymentCollection (THIS WAS MISSING)
                await paymentCollection.insertOne({
                    applicationId: application._id,
                    tuitionId: application.tuitionId,
                    tutorId: application.tutorId,
                    tutorName: application.tutor.name,
                    studentEmail: req.decoded.email,
                    paidBy: req.decoded.email,
                    amount,
                    paymentIntentId,
                    status: "succeeded",
                    createdAt: new Date(),
                });

                res.send({ success: true });
            } catch (err) {
                console.error("Payment confirmation error:", err);
                res.status(500).send({ message: "Payment confirmation failed" });
            }
        });

        // PAYMENT HISTORY
        app.get("/payments", verifyFirebaseToken,
            async (req, res) => {
                try {
                    const page = parseInt(req.query.page) || 1;
                    const limit = 10;
                    const skip = (page - 1) * limit;

                    const query = { paidBy: req.decoded.email };

                    const total = await paymentCollection.countDocuments(query);

                    const payments = await paymentCollection
                        .find(query)
                        .sort({ createdAt: -1 })
                        .skip(skip)
                        .limit(limit)
                        .toArray();

                    res.send({ total, payments });
                } catch (err) {
                    console.error("Payment history error:", err);
                    res.status(500).send({ message: "Failed to load payment history" });
                }
            }
        );

        // ADMIN – ALL PAYMENTS REPORT
        app.get("/admin/payments",
            verifyFirebaseToken,
            async (req, res) => {
                try {
                    const adminUser = await userCollection.findOne({
                        email: req.decoded.email,
                        role: "admin",
                    });

                    if (!adminUser) {
                        return res.status(403).send({ message: "Admin only" });
                    }

                    const payments = await paymentCollection
                        .find()
                        .sort({ createdAt: -1 })
                        .toArray();

                    res.send(payments);
                } catch (err) {
                    console.error("Admin payments error:", err);
                    res.status(500).send({ message: "Failed to load reports" });
                }
            }
        );




    } catch (err) {
        console.log(err);
    }
}

run().catch(console.dir());

// ------------------------------
// START SERVER
// ------------------------------

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
