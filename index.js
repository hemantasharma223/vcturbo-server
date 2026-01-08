const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialize DB Tables
db.initDB();

// Middleware
app.use(express.json());

// Configure Multer
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Upload Route
app.post('/upload', upload.single('profile_pic'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const userId = req.body.userId; // Expects INT if using Postgres SERIAL

    if (userId) {
        try {
            await db.query('UPDATE users SET profile_pic = $1 WHERE id = $2', [fileUrl, userId]);
            res.json({ success: true, url: fileUrl });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: err.message });
        }
    } else {
        res.json({ success: true, url: fileUrl });
    }
});

// State
const activeSockets = new Map(); // socketId -> userId (INT)
const onlineUsers = new Map();   // userId (INT) -> socketId

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- AUTH ---
    socket.on('auth:register', async ({ name, email, password }, callback) => {
        try {
            const { rows } = await db.query(
                'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
                [name, email, password]
            );
            callback({ success: true, userId: rows[0].id });
        } catch (err) {
            console.error(err);
            if (err.code === '23505') { // Postgres Unique Violation
                return callback({ success: false, error: "Email already exists" });
            }
            callback({ success: false, error: err.message });
        }
    });

    socket.on('auth:login', async ({ email, password }, callback) => {
        try {
            const { rows } = await db.query(
                'SELECT id, name, email, profile_pic FROM users WHERE email = $1 AND password = $2',
                [email, password]
            );

            if (rows.length > 0) {
                const user = rows[0]; // user.id is INT

                // Clear previous mappings
                const prevUserId = activeSockets.get(socket.id);
                if (prevUserId) onlineUsers.delete(prevUserId);

                const oldSocketId = onlineUsers.get(user.id);
                if (oldSocketId && oldSocketId !== socket.id) {
                    activeSockets.delete(oldSocketId);
                }

                activeSockets.set(socket.id, user.id);
                onlineUsers.set(user.id, socket.id);

                console.log(`User ${user.name} logged in. ID: ${user.id}`);
                callback({ success: true, user: user });
            } else {
                callback({ success: false, error: "Invalid credentials" });
            }
        } catch (err) {
            console.error(err);
            callback({ success: false, error: err.message });
        }
    });

    socket.on('auth:logout', (callback) => {
        const userId = activeSockets.get(socket.id);
        if (userId) {
            onlineUsers.delete(userId);
            activeSockets.delete(socket.id);
        }
        if (typeof callback === 'function') callback({ success: true });
    });

    // --- USER SEARCH ---
    socket.on('user:search', async ({ query }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            const sql = 'SELECT id, name, email, profile_pic FROM users WHERE (name ILIKE $1 OR email ILIKE $2) AND id != $3 LIMIT 20';
            const params = [`%${query}%`, `%${query}%`, userId];
            const { rows } = await db.query(sql, params);
            callback({ success: true, users: rows });
        } catch (err) {
            console.error('[SEARCH ERROR]', err);
            if (typeof callback === 'function') callback({ success: false, error: err.message });
        }
    });

    // --- FRIEND SYSTEM ---
    socket.on('friend:request', async ({ toEmail }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            const { rows: users } = await db.query('SELECT id FROM users WHERE email = $1', [toEmail]);
            if (users.length === 0) return callback({ success: false, error: "User not found" });

            const friendId = users[0].id;
            if (friendId === userId) return callback({ success: false, error: "Cannot add yourself" });

            // Check existing
            const { rows: existing } = await db.query(
                'SELECT status FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
                [userId, friendId]
            );

            if (existing.length > 0) {
                if (existing[0].status === 'accepted') return callback({ success: false, error: "Already friends" });
                return callback({ success: false, error: "Request pending" });
            }

            await db.query('INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, $3)', [userId, friendId, 'pending']);

            const friendSocket = onlineUsers.get(friendId);
            if (friendSocket) io.to(friendSocket).emit('friend:incoming_request', { fromUserId: userId });

            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('friend:list', async () => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return socket.emit('friend:list:response', { success: false, error: "Not logged in" });

        try {
            // Sent Requests
            const { rows: sent } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status, 1 as is_sender 
                FROM friends f 
                JOIN users u ON f.friend_id = u.id 
                WHERE f.user_id = $1`, [userId]);

            // Received Requests
            const { rows: received } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status, 0 as is_sender 
                FROM friends f 
                JOIN users u ON f.user_id = u.id 
                WHERE f.friend_id = $1`, [userId]);

            const allFriends = [...sent, ...received];
            socket.emit('friend:list:response', { success: true, friends: allFriends });
        } catch (err) {
            console.error(err);
            socket.emit('friend:list:response', { success: false, error: err.message });
        }
    });

    socket.on('friend:respond', async ({ friendId, accept }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            // Update where REQUEST was made (requester=friendId, recipient=userId)
            // Or allow responding if YOU made request? No.
            // But we need to find the record.
            // Simplified: Find record between these two.

            if (accept) {
                // We update 'pending' to 'accepted'
                // But specifically we want to match correct direction if possible, or just any direction?
                // Safest to update where EITHER (u=me, f=him) OR (u=him, f=me).
                await db.query(`
                    UPDATE friends SET status = 'accepted' 
                    WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)
                `, [userId, friendId]);
            } else {
                await db.query(`
                    DELETE FROM friends 
                    WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)
                `, [userId, friendId]);
            }
            if (typeof callback === 'function') callback({ success: true });

            socket.emit('friend:list:refresh');
            const targetSocket = onlineUsers.get(friendId);
            if (targetSocket) io.to(targetSocket).emit('friend:list:refresh');
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    // --- CHAT ---
    socket.on('chat:send', async ({ toUserId, message }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false });

        try {
            // Check friendship (simple count)
            const { rows } = await db.query(`
                SELECT 1 FROM friends 
                WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) 
                AND status = 'accepted'`, [userId, toUserId]);

            if (rows.length === 0) return callback({ success: false, error: "Not friends" });

            await db.query('INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3)', [userId, toUserId, message]);

            const targetSocket = onlineUsers.get(toUserId);
            if (targetSocket) io.to(targetSocket).emit('chat:receive', { fromUserId: userId, message });

            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('chat:history', async ({ withUserId }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false });

        try {
            const { rows } = await db.query(`
                SELECT id, sender_id, receiver_id, message, timestamp 
                FROM messages 
                WHERE (sender_id = $1 AND receiver_id = $2) 
                   OR (sender_id = $2 AND receiver_id = $1)
                ORDER BY timestamp ASC`, [userId, withUserId]);
            callback({ success: true, messages: rows });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    // --- CALLS ---
    socket.on('call:request', async ({ toUserId, offer }) => {
        const userId = activeSockets.get(socket.id);
        // Verify friendship? Yes.
        const targetSocket = onlineUsers.get(toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call:incoming', { fromUserId: userId, offer });
        }
    });

    socket.on('call:answer', ({ toUserId, answer }) => {
        const userId = activeSockets.get(socket.id);
        const targetSocket = onlineUsers.get(toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call:answer', { fromUserId: userId, answer });
        }
    });

    socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
        const userId = activeSockets.get(socket.id);
        const targetSocket = onlineUsers.get(toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call:ice-candidate', { fromUserId: userId, candidate });
        }
    });

    socket.on('disconnect', () => {
        const userId = activeSockets.get(socket.id);
        if (userId) {
            activeSockets.delete(socket.id);
            onlineUsers.delete(userId);
            console.log(`User ${userId} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
