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

// Configure Multer for file uploads
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
        cb(null, uniqueSuffix + path.extname(file.originalname)); // unique filename
    }
});

const upload = multer({ storage: storage });

// Serve static files (uploaded images)
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Upload Route
app.post('/upload', upload.single('profile_pic'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Construct the public URL
    // NOTE: In production (Render), this URL structure depends on how you serve static files.
    // For now we assume the server is accessible at the same base URL.
    const fileUrl = `/uploads/${req.file.filename}`;

    // If the request includes userId, let's update the database immediately
    // Ideally user ID should come from valid auth token, but for now we trust the client or separate logic
    // Using loose coupling: Client uploads, gets URL, then triggers socket to update profile if needed?
    // OR client sends userID in body. Let's support userID in body.

    const userId = req.body.userId;
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

    // --- AUTHENTICATION ---
    socket.on('auth:register', async ({ name, email, password }, callback) => {
        try {
            const { rows } = await db.query(
                'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
                [name, email, password] // Plain text for MVP as requested
            );
            callback({ success: true, userId: rows[0].id });
        } catch (err) {
            console.error(err);
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
                const user = rows[0];
                activeSockets.set(socket.id, user.id);
                onlineUsers.set(user.id, socket.id);
                console.log(`User ${user.name} logged in`);
                callback({ success: true, user: user });

                // Notify friends needed? Maybe later.
            } else {
                callback({ success: false, error: "Invalid credentials" });
            }
        } catch (err) {
            console.error(err);
            callback({ success: false, error: err.message });
        }
    });

    // --- USER PROFILE UPDATE via Socket ---
    socket.on('user:update_profile_pic', async ({ url }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            await db.query('UPDATE users SET profile_pic = $1 WHERE id = $2', [url, userId]);
            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    // --- USER SEARCH ---
    socket.on('user:search', async ({ query }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            // Search by name or email, exclude self
            const { rows } = await db.query(
                'SELECT id, name, email, profile_pic FROM users WHERE (name ILIKE $1 OR email ILIKE $1) AND id != $2 LIMIT 20',
                [`%${query}%`, userId]
            );
            callback({ success: true, users: rows });
        } catch (err) {
            console.error(err);
            callback({ success: false, error: err.message });
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

            await db.query(
                'INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, $3)',
                [userId, friendId, 'pending']
            );

            // Real-time notification
            const friendSocket = onlineUsers.get(friendId);
            if (friendSocket) {
                io.to(friendSocket).emit('friend:incoming_request', { fromUserId: userId });
            }

            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('friend:list', async (callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false });

        try {
            // Get friends where user is sender
            const { rows: sent } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status 
                FROM friends f 
                JOIN users u ON f.friend_id = u.id 
                WHERE f.user_id = $1`, [userId]);

            // Get friends where user is receiver
            const { rows: received } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status 
                FROM friends f 
                JOIN users u ON f.user_id = u.id 
                WHERE f.friend_id = $1`, [userId]);

            callback({ success: true, friends: [...sent, ...received] });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('friend:respond', async ({ friendId, accept }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return;

        try {
            if (accept) {
                await db.query(
                    'UPDATE friends SET status = $1 WHERE user_id = $2 AND friend_id = $3',
                    ['accepted', friendId, userId]
                );
            } else {
                await db.query(
                    'DELETE FROM friends WHERE user_id = $1 AND friend_id = $2',
                    [friendId, userId]
                );
            }
            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    // Helper to check friendship
    async function checkFriendship(userA, userB) {
        const { rows } = await db.query(`
            SELECT 1 FROM friends 
            WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) 
            AND status = 'accepted'
        `, [userA, userB]);
        return rows.length > 0;
    }

    // --- CHAT SYSTEM ---
    socket.on('chat:send', async ({ toUserId, message }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false });

        try {
            const isFriend = await checkFriendship(userId, toUserId);
            if (!isFriend) return callback({ success: false, error: "You can only chat with friends." });

            await db.query(
                'INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3)',
                [userId, toUserId, message]
            );

            const targetSocket = onlineUsers.get(toUserId);
            if (targetSocket) {
                io.to(targetSocket).emit('chat:receive', { fromUserId: userId, message });
            }
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
                SELECT * FROM messages 
                WHERE (sender_id = $1 AND receiver_id = $2) 
                   OR (sender_id = $3 AND receiver_id = $4)
                ORDER BY timestamp ASC`,
                [userId, withUserId, withUserId, userId]
            );
            callback({ success: true, messages: rows });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    // --- DIRECT CALL SIGNALING ---
    socket.on('call:request', async ({ toUserId, offer }) => {
        const userId = activeSockets.get(socket.id);
        const targetSocket = onlineUsers.get(toUserId);

        const isFriend = await checkFriendship(userId, toUserId);
        if (!isFriend) {
            // If callback existed, we would return error, but here we just don't emit
            // Or emit an error event back to sender
            socket.emit('call:error', { error: "Not friends" });
            return;
        }

        if (targetSocket) {
            io.to(targetSocket).emit('call:incoming', {
                fromUserId: userId,
                offer: offer
            });
        }
    });

    socket.on('call:answer', ({ toUserId, answer }) => {
        const userId = activeSockets.get(socket.id);
        const targetSocket = onlineUsers.get(toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call:answer', {
                fromUserId: userId,
                answer: answer
            });
        }
    });

    socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
        const userId = activeSockets.get(socket.id);
        const targetSocket = onlineUsers.get(toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call:ice-candidate', {
                fromUserId: userId,
                candidate: candidate
            });
        }
    });

    // --- RANDOM CHAT REMOVED ---

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
