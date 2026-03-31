const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'u380941797_vcturbo',
    password: process.env.DB_PASSWORD || 'Bhurtel1212@',
    database: process.env.DB_NAME || 'u380941797_vcturbo',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
