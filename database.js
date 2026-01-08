const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false } // Required for Supabase/Heroku usually
});

// Helper for queries
const query = (text, params) => pool.query(text, params);

// Initialize Tables
const initDB = async () => {
    try {
        console.log("Initializing PostgreSQL Tables...");

        // Users
        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                profile_pic TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Friends
        await query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id),
                friend_id INT NOT NULL REFERENCES users(id),
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Messages
        await query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INT NOT NULL REFERENCES users(id),
                receiver_id INT NOT NULL REFERENCES users(id),
                message TEXT NOT NULL,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("Tables initialized successfully.");
    } catch (err) {
        console.error("Error initializing database:", err);
        // Don't exit process here, maybe allow retry or manual fix
    }
};

module.exports = { query, initDB, pool };
