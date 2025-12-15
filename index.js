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
    const authHeader = req.headersauthorization || req.headers.authorization;
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
            const tuition = await tuitionCollection.findOne({ _id: new ObjectId(req.params.id) });

            const applications = await applicationCollection
                .find({ tuitionId: tuition._id })
                .toArray();

            res.send({ tuition, applications });
        });


        // =====================================================
        // TUITIONS (ONLY SMALL ADDITION)
        // =====================================================
        app.post("/tuitions", verifyFirebaseToken, async (req, res) => {
            const data = req.body;

            data.createdAt = new Date();
            data.status = "pending";

            data.postedByEmail = req.decoded.email;
            data.postedByRole = "student";

            const tuitionId = await getNextTuitionId(db);
            data.tuitionId = tuitionId;

            const result = await tuitionCollection.insertOne(data);
            res.send({ insertedId: result.insertedId, tuitionId });
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
        // STUDENT – MY TUITIONS
        // =====================================================
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



        // STUDENT – TUITION ANALYTICS
        app.get("/student/tuition-analytics/:id", verifyFirebaseToken, async (req, res) => {
            const tuitionId = new ObjectId(req.params.id);
            const { university, department, experience, runningYear } = req.query;

            let tutorFilters = {};
            if (university) tutorFilters["tutor.university"] = { $regex: university, $options: "i" };
            if (department) tutorFilters["tutor.department"] = { $regex: department, $options: "i" };
            if (experience) tutorFilters["tutor.experience"] = { $gte: experience };
            if (runningYear) tutorFilters["tutor.runningYear"] = runningYear;

            const tutors = await applicationCollection.aggregate([
                { $match: { tuitionId } },
                {
                    $lookup: {
                        from: "users",
                        localField: "tutorId",
                        foreignField: "_id",
                        as: "tutor"
                    }
                },
                { $unwind: "$tutor" },
                { $match: tutorFilters },
                {
                    $project: {
                        "tutor.email": 0,
                        "tutor.contactEmail": 0
                    }
                }
            ]).toArray();

            res.send(tutors.map(t => t.tutor));
        });


        // GET tutors applied to a tuition (with filters)
        app.get("/student/tuition/:id/applicants",
            verifyFirebaseToken,
            async (req, res) => {
                try {
                    const tuitionObjectId = new ObjectId(req.params.id);

                    let tutorFilters = {
                        "tutor.role": "tutor",
                        "tutor.status": "approved"
                    };

                    const regex = v => ({ $regex: v, $options: "i" });

                    if (req.query.university) tutorFilters["tutor.university"] = regex(req.query.university);
                    if (req.query.department) tutorFilters["tutor.department"] = regex(req.query.department);
                    if (req.query.experience) tutorFilters["tutor.experience"] = regex(req.query.experience);
                    if (req.query.runningYear) tutorFilters["tutor.runningYear"] = regex(req.query.runningYear);
                    if (req.query.ssc) tutorFilters["tutor.ssc"] = regex(req.query.ssc);
                    if (req.query.hsc) tutorFilters["tutor.hsc"] = regex(req.query.hsc);

                    const applications = await applicationCollection.aggregate([
                        { $match: { tuitionId: tuitionObjectId } },
                        {
                            $lookup: {
                                from: "users",
                                localField: "tutorId",
                                foreignField: "_id",
                                as: "tutor"
                            }
                        },
                        { $unwind: "$tutor" },
                        { $match: tutorFilters },
                        {
                            $project: {
                                "tutor.email": 0,
                                "tutor.contactEmail": 0
                            }
                        }
                    ]).toArray();

                    res.send(applications);
                } catch (err) {
                    console.error("Analytics error:", err);
                    res.status(500).send({ message: "Failed to load tutor analytics" });
                }
            }
        );






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



        // =====================================================
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
        // ALL OTHER ROUTES (UNCHANGED)
        // =====================================================
        // Applications, Payments, Tutors, Details APIs

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
