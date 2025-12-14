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
        // ✅ ADMIN – USER MANAGEMENT (PAGINATED)
        // =====================================================
        app.get("/admin/users", verifyFirebaseToken, async (req, res) => {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 15;
            const skip = (page - 1) * limit;

            const total = await userCollection.countDocuments();

            const users = await userCollection
                .find()
                .sort({ createdAt: -1 }) // latest first
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({
                total,
                page,
                limit,
                users
            });
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
        // TUITIONS (UNCHANGED)
        // =====================================================
        app.post("/tuitions", async (req, res) => {
            const data = req.body;
            data.createdAt = new Date();
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

            const total = await tuitionCollection.countDocuments(filters);

            const tuitions = await tuitionCollection
                .find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.send({ total, tuitions });
        });

        // =====================================================
        // ALL OTHER ROUTES (UNCHANGED)
        // =====================================================
        // Applications, Payments, Tutors, Details APIs
        // (No changes made)

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
