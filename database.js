const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
};

let pool;

// Helper to mimic pg's result structure { rows }
const query = async (sql, params) => {
    if (!pool) await initDB();
    const start = Date.now();
    try {
        // Use a wrapper to ensure we don't hang forever
        const promise = pool.query(sql, params);
        const [rows] = await promise;
        const duration = Date.now() - start;
        if (duration > 100) {
            console.log(`[SLOW QUERY] ${duration}ms: ${sql.substring(0, 100)}...`);
        }
        return { rows };
    } catch (err) {
        console.error(`[DB ERROR] Query: ${sql}`, err);
        throw err;
    }
};

// Initialize DB and Tables
const initDB = async () => {
    try {
        // 1. Connect without database to create it if needed
        const connection = await mysql.createConnection(dbConfig);
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'vcturbo'}\``);
        await connection.end();

        // 2. Create the pool with the database
        pool = mysql.createPool({
            ...dbConfig,
            database: process.env.DB_NAME || 'vcturbo',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        console.log(`Using database: ${process.env.DB_NAME || 'vcturbo'}`);

        // 3. Create Tables
        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                profile_pic TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS friends (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                friend_id INT NOT NULL,
                status ENUM('pending', 'accepted') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (friend_id) REFERENCES users(id)
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id INT NOT NULL,
                receiver_id INT NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sender_id) REFERENCES users(id),
                FOREIGN KEY (receiver_id) REFERENCES users(id)
            )
        `);

        console.log("Database and tables initialized successfully (MySQL)");
    } catch (err) {
        console.error("Error initializing database:", err);
        // Important: If this fails, the server should probably exit or retry
        process.exit(1);
    }
}

// Initial trigger
initDB();

module.exports = { query };
