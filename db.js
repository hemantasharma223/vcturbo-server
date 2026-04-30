const { Pool } = require('pg');
require('dotenv').config();

<<<<<<< HEAD
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
=======
const pool = mysql.createPool({
    host: 'localhost',
    user: 'u380941797_vcturbo',
    password: 'Bhurtel1212@',
    database: 'u380941797_vcturbo',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
>>>>>>> 37b232d697452cfd75de34a18a00d30354c9b603
});

module.exports = pool;
