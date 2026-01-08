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

// Middleware
app.use(express.json());

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
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Upload Route
app.post('/upload', upload.single('profile_pic'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const userId = req.body.userId;

    if (userId) {
        try {
            await db.query('UPDATE users SET profile_pic = ? WHERE id = ?', [fileUrl, userId]);
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
                'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
                [name, email, password]
            );
            callback({ success: true, userId: rows.insertId });
        } catch (err) {
            console.error(err);
            callback({ success: false, error: err.message });
        }
    });

    socket.on('auth:login', async ({ email, password }, callback) => {
        try {
            const { rows } = await db.query(
                'SELECT id, name, email, profile_pic FROM users WHERE email = ? AND password = ?',
                [email, password]
            );

            if (rows.length > 0) {
                const user = rows[0];

                // CLEAR STALE MAPPINGS
                // 1. If this socket was associated with another user, remove that user's online status
                const prevUserId = activeSockets.get(socket.id);
                if (prevUserId) {
                    onlineUsers.delete(prevUserId);
                }

                // 2. If this new user was logged in on another socket, remove that socket's mapping
                const oldSocketId = onlineUsers.get(user.id);
                if (oldSocketId && oldSocketId !== socket.id) {
                    console.log(`User ${user.name} replacing socket ${oldSocketId} with ${socket.id}`);
                    activeSockets.delete(oldSocketId);
                }

                activeSockets.set(socket.id, user.id);
                onlineUsers.set(user.id, socket.id);

                console.log(`User ${user.name} logged in. Total online: ${onlineUsers.size}`);
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
            console.log(`User ${userId} requested explicit logout`);
            onlineUsers.delete(userId);
            activeSockets.delete(socket.id);
        }
        if (typeof callback === 'function') callback({ success: true });
    });

    // --- USER PROFILE UPDATE via Socket ---
    socket.on('user:update_profile_pic', async ({ url }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            await db.query('UPDATE users SET profile_pic = ? WHERE id = ?', [url, userId]);
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
            console.log(`[SEARCH] query: "${query}", userId: ${userId}`);
            const sql = 'SELECT id, name, email, profile_pic FROM users WHERE (name LIKE ? OR email LIKE ?) AND id != ? LIMIT 20';
            const params = [`%${query}%`, `%${query}%`, userId];
            const { rows } = await db.query(sql, params);
            console.log(`[SEARCH] Found ${rows.length} results`);
            if (typeof callback === 'function') callback({ success: true, users: rows });
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
            const { rows: users } = await db.query('SELECT id FROM users WHERE email = ?', [toEmail]);
            if (users.length === 0) return callback({ success: false, error: "User not found" });

            const friendId = users[0].id;
            if (friendId === userId) return callback({ success: false, error: "Cannot add yourself" });

            await db.query(
                'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
                [userId, friendId, 'pending']
            );

            const friendSocket = onlineUsers.get(friendId);
            if (friendSocket) {
                io.to(friendSocket).emit('friend:incoming_request', { fromUserId: userId });
            }

            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('friend:list', async () => {
        const userId = activeSockets.get(socket.id);
        console.log(`[FRIEND LIST] Request from ${socket.id}, mapped to userId: ${userId}`);

        if (!userId) {
            return socket.emit('friend:list:response', { success: false, error: "Not logged in" });
        }

        try {
            console.time(`[DB] list_${userId}`);
            const { rows: sent } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status, 1 as is_sender 
                FROM friends f 
                JOIN users u ON f.friend_id = u.id 
                WHERE f.user_id = ?`, [userId]);

            const { rows: received } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status, 0 as is_sender 
                FROM friends f 
                JOIN users u ON f.user_id = u.id 
                WHERE f.friend_id = ?`, [userId]);
            console.timeEnd(`[DB] list_${userId}`);

            const allFriends = [...sent, ...received];
            console.log(`[FRIEND LIST] Sending ${allFriends.length} items to user ${userId}`);

            socket.emit('friend:list:response', { success: true, friends: allFriends });
        } catch (err) {
            console.error('[FRIEND LIST ERROR]', err);
            socket.emit('friend:list:response', { success: false, error: err.message });
        }
    });

    socket.on('friend:respond', async ({ friendId, accept }, callback) => {
        const userId = activeSockets.get(socket.id);
        console.log(`[FRIEND RESPOND] ${userId} -> ${friendId} (accept: ${accept})`);
        if (!userId) {
            if (typeof callback === 'function') callback({ success: false, error: "Not logged in" });
            return;
        }

        try {
            if (accept) {
                await db.query(
                    'UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?',
                    ['accepted', friendId, userId]
                );
            } else {
                await db.query(
                    'DELETE FROM friends WHERE user_id = ? AND friend_id = ?',
                    [friendId, userId]
                );
            }
            if (typeof callback === 'function') callback({ success: true });

            // Notify both to refresh lists
            socket.emit('friend:list:refresh');
            const targetSocket = onlineUsers.get(friendId);
            if (targetSocket) {
                io.to(targetSocket).emit('friend:list:refresh');
            }
        } catch (err) {
            console.error('[FRIEND RESPOND ERROR]', err);
            if (typeof callback === 'function') callback({ success: false, error: err.message });
        }
    });

    async function checkFriendship(userA, userB) {
        const { rows } = await db.query(`
            SELECT 1 FROM friends 
            WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) 
            AND status = 'accepted'
        `, [userA, userB, userB, userA]);
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
                'INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)',
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
                SELECT id, sender_id, receiver_id, message, timestamp 
                FROM messages 
                WHERE (sender_id = ? AND receiver_id = ?) 
                   OR (sender_id = ? AND receiver_id = ?)
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
