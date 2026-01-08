const mysql = require('mysql2/promise');

const dbConfig = {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'vcturbo',
    port: process.env.MYSQL_PORT || 3306,
};

let pool;

// Helper to mimic pg's { rows } structure
const query = async (sql, params) => {
    if (!pool) await initDB();
    const start = Date.now();
    try {
        const [rows] = await pool.query(sql, params);
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
        // Connect without database first to create it if missing
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password,
            port: dbConfig.port
        });

        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
        await connection.end();

        // Create pool with DB
        pool = mysql.createPool({
            ...dbConfig,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        console.log(`Using database: ${dbConfig.database}`);

        // Create Tables
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

        console.log("Database and tables initialized successfully");
    } catch (err) {
        console.error("Error initializing database:", err);
        process.exit(1);
    }
};

// Trigger initialization
initDB();

module.exports = { query };
