const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");

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


//SUPER_ADMIN_EMAIL
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
// AUTO-INCREMENT FUNCTION FOR TUITION ID (T0001, T0002...)
// -------------------------------------------------------
async function getNextTuitionId(db) {
    const result = await db.collection("counters").findOneAndUpdate(
        { _id: "tuitionId" },
        { $inc: { sequence_value: 1 } },
        { returnDocument: "after", upsert: true }
    );

    const nextId = result.sequence_value;
    return "T" + nextId.toString().padStart(4, "0");
}

async function run() {
    try {
        await client.connect();
        console.log("Connected to MongoDB!");

        const db = client.db("eTuitionBd");
        const userCollection = db.collection("users");
        const tuitionCollection = db.collection("tuitions");
        const applicationCollection = db.collection("applications");

        // =====================================================
        // USERS API
        // =====================================================

        /* ==========================
               BASIC TEST
            =========================== */
        app.get("/", (req, res) => {
            res.send("Server running");
        });

        /* ==========================
           USERS
        =========================== */
        app.post("/users", verifyFirebaseToken, async (req, res) => {
            const user = req.body;

            // 🔐 prevent email spoofing
            if (req.decoded.email !== user.email) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            const exists = await userCollection.findOne({ email: user.email });
            if (exists) {
                return res.send({ message: "User already exists" });
            }

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

            if (!user) {
                return res.send({ role: null, status: null });
            }

            res.send({
                role: user.role,
                status: user.status,
            });
        });

        /* ==========================
           ADMIN – USER MANAGEMENT
        =========================== */
        app.get("/admin/users", async (req, res) => {
            const users = await userCollection
                .find()
                .sort({ createdAt: -1 })
                .toArray();
            res.send(users);
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

        // =====================================================
        // TUITIONS API (CREATE + LIST + DETAILS)
        // =====================================================

        // CREATE TUITION
        app.post("/tuitions", async (req, res) => {
            try {
                const data = req.body;
                data.createdAt = new Date();

                const tuitionId = await getNextTuitionId(db);
                data.tuitionId = tuitionId;

                const result = await tuitionCollection.insertOne(data);

                res.send({ insertedId: result.insertedId, tuitionId });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // GET ALL TUITIONS
        app.get("/tuitions", async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 12;
                const page = parseInt(req.query.page) || 1;

                let filters = {};

                const regexField = (field) => ({
                    $regex: req.query[field],
                    $options: "i"
                });

                if (req.query.class) filters.class = regexField("class");
                if (req.query.subjects) filters.subjects = regexField("subjects");
                if (req.query.university) filters.university = regexField("university");
                if (req.query.uniSubject) filters.uniSubject = regexField("uniSubject");
                if (req.query.location) filters.location = regexField("location");
                if (req.query.schedule) filters.schedule = regexField("schedule");

                const skip = (page - 1) * limit;

                const total = await tuitionCollection.countDocuments(filters);

                const tuitions = await tuitionCollection
                    .find(filters)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .toArray();

                res.send({ total, tuitions });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        // GET SINGLE TUITION (PUBLIC PAGE)
        app.get("/tuitions/:tuitionId", async (req, res) => {
            const tuitionId = req.params.tuitionId;
            const tuition = await tuitionCollection.findOne({ tuitionId });

            if (!tuition) return res.status(404).send({ error: "Tuition not found" });

            res.send(tuition);
        });


        app.get("tutor/tuitions/:tuitionId", async (req, res) => {
            const tuitionId = req.params.tuitionId;
            const tuition = await tuitionCollection.findOne({ tuitionId });

            if (!tuition) return res.status(404).send({ error: "Tuition not found" });

            res.send(tuition);
        });

        // =====================================================
        // APPLICATION API
        // =====================================================

        // APPLY FOR TUITION
        app.post("/tuitions/:tuitionId/apply", async (req, res) => {
            try {
                const tuitionId = req.params.tuitionId;

                const data = {
                    tuitionId,
                    tutorEmail: req.body.tutorEmail,
                    tutorName: req.body.tutorName,
                    createdAt: new Date(),
                    isPaid: false
                };

                const result = await applicationCollection.insertOne(data);
                res.send({ applied: true, id: result.insertedId });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // =====================================================
        // DASHBOARD: MY TUITIONS
        // =====================================================

        // MY TUITIONS LIST
        app.get("/my-tuitions/:email", async (req, res) => {
            try {
                const tuitions = await tuitionCollection
                    .find({ postedBy: req.params.email })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(tuitions);

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // MY TUITION DETAILS
        app.get("/my-tuition-details/:tuitionId", async (req, res) => {
            try {
                const tuitionId = req.params.tuitionId;

                const tuition = await tuitionCollection.findOne({ tuitionId });

                if (!tuition) return res.status(404).send({ error: "Not found" });

                const applicantCount = await applicationCollection.countDocuments({
                    tuitionId
                });

                res.send({ ...tuition, totalApplicants: applicantCount });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // =====================================================
        // EDIT TUITION (🔥 FIXED — ONLY CHANGE MADE)
        // =====================================================
        app.put("/tuitions/:tuitionId", async (req, res) => {
            try {
                const tuitionId = req.params.tuitionId;

                const data = { ...req.body };
                delete data._id; // ❗ Prevent MongoDB _id overwrite error

                const result = await tuitionCollection.updateOne(
                    { tuitionId },
                    { $set: data }
                );

                res.send({ success: true, updated: result.modifiedCount });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // DELETE TUITION
        app.delete("/tuitions/:tuitionId", async (req, res) => {
            try {
                const tuitionId = req.params.tuitionId;

                await tuitionCollection.deleteOne({ tuitionId });
                await applicationCollection.deleteMany({ tuitionId });

                res.send({ deleted: true });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // =====================================================
        // APPLICATION LIST BY TUITION
        // =====================================================
        app.get("/applications/by-tuition/:tuitionId", async (req, res) => {
            try {
                const tuitionId = req.params.tuitionId;

                const apps = await applicationCollection
                    .find({ tuitionId })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(apps);

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // APPLICATION DETAILS
        app.get("/applications/details/:id", async (req, res) => {
            try {
                const id = req.params.id;

                const appData = await applicationCollection.findOne({
                    _id: new ObjectId(id)
                });

                if (!appData) return res.status(404).send({});

                const tutor = await userCollection.findOne(
                    { email: appData.tutorEmail },
                    {
                        projection: {
                            name: 1,
                            photo: 1,
                            university: 1,
                            department: 1,
                            ssc: 1,
                            hsc: 1,
                            runningYear: 1,
                            experience: 1,
                            email: 1,
                            phone: 1
                        }
                    }
                );

                if (!appData.isPaid) {
                    tutor.email = "pro*********@gmail.com";
                    tutor.phone = "01*********";
                }

                res.send({ application: appData, tutor });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // =====================================================
        // PAYMENT API
        // =====================================================

        app.post("/create-payment-intent", async (req, res) => {
            try {
                const { applicationId } = req.body;

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: 1000 * 100,
                    currency: "bdt",
                    metadata: { applicationId },
                });

                res.send({
                    clientSecret: paymentIntent.client_secret
                });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.put("/applications/mark-paid/:id", async (req, res) => {
            try {
                await applicationCollection.updateOne(
                    { _id: new ObjectId(req.params.id) },
                    { $set: { isPaid: true } }
                );

                res.send({ success: true });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        // GET ALL TUTORS WITH FILTERS + SORT BY LATEST
        // GET ALL TUTORS WITH FILTERS + PAGINATION
        app.get("/tutors", async (req, res) => {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 12;

            const filters = { role: "tutor" };
            const allowedFilters = ["university", "department", "experience", "runningYear", "ssc", "hsc"];

            allowedFilters.forEach(field => {
                if (req.query[field] && req.query[field] !== "") {
                    filters[field] = { $regex: req.query[field], $options: "i" };
                }
            });

            const skip = (page - 1) * limit;

            const totalTutors = await userCollection.countDocuments(filters);
            const tutors = await userCollection
                .find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({
                total: totalTutors,
                tutors
            });
        });



        // GET SINGLE TUTOR BY ID
        app.get("/tutors/details/:id", async (req, res) => {
            try {
                const id = req.params.id;

                const tutor = await userCollection.findOne(
                    { _id: new ObjectId(id) },
                    {
                        projection: {
                            name: 1,
                            photoURL: 1,
                            university: 1,
                            department: 1,
                            ssc: 1,
                            hsc: 1,
                            runningYear: 1,
                            experience: 1,
                            phone: 1,
                            email: 1,
                            contactPhone: 1,
                            contactEmail: 1,
                            createdAt: 1,
                            role: 1,
                        }
                    }
                );

                if (!tutor) return res.status(404).send({ error: "Tutor not found" });

                // MASK sensitive fields by default
                tutor.phone = "01**********";
                tutor.email = "pr********@gmail.com";
                tutor.contactPhone = "01**********";
                tutor.contactEmail = "pr********@gmail.com";

                res.send({ tutor });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });



    } catch (err) {
        console.log(err);
    }
}

run().catch(console.dir());

// ------------------------------
// START SERVER
// ------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
