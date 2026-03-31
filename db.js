const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: 'localhost',
    user: 'u380941797_vcturbo',
    password: 'Bhurtel1212@',
    database: 'u380941797_vcturbo',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});


module.exports = pool;
