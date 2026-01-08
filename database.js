const { MongoClient, ServerApiVersion } = require('mongodb');

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db;

async function connectDB() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
        db = client.db("vcturbo"); // Use specific DB name
    } catch (err) {
        console.error("MongoDB Connection Error:", err);
        process.exit(1);
    }
}

function getDb() {
    if (!db) throw new Error("Database not initialized. Call connectDB first.");
    return db;
}

module.exports = { connectDB, getDb, client };
