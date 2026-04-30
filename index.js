const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const db = require('./db');


const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

// ---------------- ROUTES ----------------
app.get('/', (req, res) => {
    res.send("<h1>VC Turbo Server is Live!</h1><p>The socket server is running on port " + PORT + "</p>");
});

app.get('/health', (req, res) => {
    res.json({ status: "ok", message: "MeetLoop Server is operational" });
});


// ---------------- STATE ----------------
const activeSockets = new Map(); // socketId -> userId
const onlineUsers = new Map();   // userId -> socketId

// ---------------- SOCKET ----------------
io.on('connection', (socket) => {
    console.log("Connected:", socket.id);

    // -------- AUTH REGISTER --------
    socket.on('auth:register', async (data, cb) => {
        try {
            const { name, email, password } = data;
            if (!name || !email || !password) {
                if (typeof cb === 'function') cb({ success: false, error: "Incomplete data" });
                return;
            }

            // Check if email exists
            const existing = await db.query("SELECT id FROM users WHERE email = $1", [email]);
            if (existing.rows.length > 0) {
                if (typeof cb === 'function') cb({ success: false, error: "Email already exists" });
                return;
            }

            const result = await db.query(
                "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id", 
                [name, email, password]
            );

            if (typeof cb === 'function') cb({ success: true, userId: result.rows[0].id });
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- AUTH LOGIN --------
    socket.on('auth:login', async ({ email, password }, cb) => {
        try {
            if (!email || !password) {
                if (typeof cb === 'function') cb({ success: false, error: "Incomplete data" });
                return;
            }

            const { rows } = await db.query(
                "SELECT id, name, email, profile_pic FROM users WHERE email = $1 AND password = $2", 
                [email, password]
            );

            if (rows.length > 0) {
                const user = rows[0];
                activeSockets.set(socket.id, user.id);
                onlineUsers.set(user.id, socket.id);
                if (typeof cb === 'function') cb({ success: true, user });
            } else {
                if (typeof cb === 'function') cb({ success: false, error: "Invalid credentials" });
            }
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- LOGOUT --------
    socket.on('auth:logout', (cb) => {
        const userId = activeSockets.get(socket.id);
        if (userId) onlineUsers.delete(userId);
        activeSockets.delete(socket.id);
        if (typeof cb === 'function') cb({ success: true });
    });



    // -------- FRIEND REQUEST --------
    socket.on('friend:request', async (data, cb) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof cb === 'function') cb({ success: false, error: "Not logged in" });
            return;
        }

        try {
            let friendId = data.friendId;

            // Find via email if friendId not provided
            if (!friendId && data.toEmail) {
                const { rows: users } = await db.query("SELECT id FROM users WHERE email = $1", [data.toEmail]);
                if (users.length === 0) {
                    if (typeof cb === 'function') cb({ success: false, error: "User not found" });
                    return;
                }
                friendId = users[0].id;
            }

            if (userId == friendId) {
                if (typeof cb === 'function') cb({ success: false, error: "Cannot add yourself" });
                return;
            }

            // Check existing
            const existing = await db.query(
                "SELECT status FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $3 AND friend_id = $4)",
                [userId, friendId, friendId, userId]
            );

            if (existing.rows.length > 0) {
                const status = existing.rows[0].status;
                if (status === 'accepted') {
                    if (typeof cb === 'function') cb({ success: false, error: "Already friends" });
                } else {
                    if (typeof cb === 'function') cb({ success: false, error: "Request pending" });
                }
                return;
            }

            // Insert request
            await db.query(
                "INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')",
                [userId, friendId]
            );

            if (typeof cb === 'function') cb({ success: true, friendId });

            const targetSocket = onlineUsers.get(friendId);
            if (targetSocket) {
                io.to(targetSocket).emit('friend:incoming_request', { fromUserId: userId });
            }
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- FRIEND LIST --------
    socket.on('friend:list', async (data, cb) => {
        if (typeof data === 'function') {
            cb = data;
            data = {};
        }

        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof cb === 'function') cb({ success: false, error: "Not logged in" });
            return;
        }

        try {
            // Sent Requests
            const { rows: sent } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status, 1 as is_sender 
                FROM friends f 
                JOIN users u ON f.friend_id = u.id 
                WHERE f.user_id = $1
            `, [userId]);

            // Received Requests
            const { rows: received } = await db.query(`
                SELECT u.id, u.name, u.email, u.profile_pic, f.status, 0 as is_sender 
                FROM friends f 
                JOIN users u ON f.user_id = u.id 
                WHERE f.friend_id = $1
            `, [userId]);

            let friends = [...sent, ...received];

            // Inject online status
            friends = friends.map(f => ({
                ...f,
                is_online: onlineUsers.has(f.id)
            }));

            const response = { success: true, friends };
            if (typeof cb === 'function') cb(response);
            socket.emit('friend:list:response', response);
        } catch (err) {
            const errorRes = { success: false, error: err.message };
            if (typeof cb === 'function') cb(errorRes);
            socket.emit('friend:list:response', errorRes);
        }
    });

    // -------- FRIEND RESPOND --------
    socket.on('friend:respond', async ({ friendId, accept }, cb) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof cb === 'function') cb({ success: false, error: "Not logged in" });
            return;
        }

        try {
            if (accept) {
                await db.query(
                    "UPDATE friends SET status = 'accepted' WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $3 AND friend_id = $4)",
                    [userId, friendId, friendId, userId]
                );
            } else {
                await db.query(
                    "DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $3 AND friend_id = $4)",
                    [userId, friendId, friendId, userId]
                );
            }

            const targetSocket = onlineUsers.get(friendId);
            if (targetSocket) io.to(targetSocket).emit('friend:list:refresh');
            socket.emit('friend:list:refresh');

            if (typeof cb === 'function') cb({ success: true });
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- USER SEARCH --------
    socket.on('user:search', async ({ query }, cb) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof cb === 'function') cb({ success: false, error: "Not logged in" });
            return;
        }

        try {
            const search = `%${query}%`;
            const { rows: users } = await db.query(
                "SELECT id, name, email, profile_pic FROM users WHERE (name LIKE $1 OR email LIKE $2) AND id != $3 LIMIT 20",
                [search, search, userId]
            );
            if (typeof cb === 'function') cb({ success: true, users });
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- CHAT SEND --------
    socket.on('chat:send', async ({ toUserId, message }, cb) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof cb === 'function') cb({ success: false });
            return;
        }

        try {
            await db.query(
                "INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3)",
                [userId, toUserId, message]
            );

            const targetSocket = onlineUsers.get(toUserId);
            if (targetSocket) {
                io.to(targetSocket).emit('chat:receive', { fromUserId: userId, message });
            }


            if (typeof cb === 'function') cb({ success: true });
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- CHAT HISTORY --------
    socket.on('chat:history', async ({ withUserId }, cb) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof cb === 'function') cb({ success: false });
            return;
        }

        try {
            const { rows: messages } = await db.query(
                "SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4) ORDER BY timestamp ASC",
                [userId, withUserId, withUserId, userId]
            );
            if (typeof cb === 'function') cb({ success: true, messages });
        } catch (err) {
            if (typeof cb === 'function') cb({ success: false, error: err.message });
        }
    });

    // -------- CALL SIGNALING --------
    socket.on('call:request', async ({ toUserId, offer }) => {
        const userId = activeSockets.get(socket.id);
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

    // -------- DISCONNECT --------
    socket.on('disconnect', () => {
        const userId = activeSockets.get(socket.id);
        if (userId) onlineUsers.delete(userId);
        activeSockets.delete(socket.id);
        console.log("Disconnected:", socket.id);
    });
});

// ---------------- SERVER ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    
    // Test DB connection on startup
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                profile_pic TEXT
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(50) NOT NULL DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Database connected and tables created successfully!");
    } catch (err) {
        console.error("Database connection failed!", err.message);
    }
});

