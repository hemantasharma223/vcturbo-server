const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.PORT || 5432,
    ssl: {
        rejectUnauthorized: false
    }
});

async function initDB() {
    try {
        const client = await pool.connect();

        console.log("Initializing Database Tables...");

        // Users Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Friends Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL,
                friend_id INT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (friend_id) REFERENCES users(id),
                UNIQUE (user_id, friend_id)
            )
        `);

        // Messages Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INT NOT NULL,
                receiver_id INT NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sender_id) REFERENCES users(id),
                FOREIGN KEY (receiver_id) REFERENCES users(id)
            )
        `);

        console.log("Database initialized successfully");
        client.release();
    } catch (err) {
        console.error("Error initializing database:", err);
    }
}

initDB();

module.exports = pool;
