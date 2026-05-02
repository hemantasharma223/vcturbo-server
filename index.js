const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
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

app.use(express.json({ limit: '5mb' })); // Allow base64 image frames

// ---------------- ROUTES ----------------
app.get('/', (req, res) => {
    res.send("<h1>VC Turbo Server is Live!</h1><p>The socket server is running on port " + PORT + "</p>");
});

app.get('/health', (req, res) => {
    res.json({ status: "ok", message: "MeetLoop Server is operational" });
});

// ---------------- MODERATION PROXY ----------------
// Flutter sends frames here; we forward to the Python service
app.post('/moderation/check', async (req, res) => {
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ safe: true, reason: null });

        const moderationUrl = process.env.MODERATION_URL || 'http://localhost:8000';
        const response = await axios.post(`${moderationUrl}/analyze`, { image }, {
            timeout: 4000, // 4s timeout – if moderation is slow, fail open
        });

        return res.json(response.data);
    } catch (err) {
        // Fail open: if moderation service is down, don't block users
        console.error('Moderation proxy error:', err.message);
        return res.json({ safe: true, reason: null });
    }
});


// ---------------- STATE ----------------
const activeSockets = new Map(); // socketId -> userId
const onlineUsers = new Map();   // userId -> socketId
let waitingQueue = [];           // [{ socketId, country }]
const activeMatches = new Map(); // socketId -> peerSocketId

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



    // -------- RANDOM MATCHMAKING --------
    socket.on('random:join', ({ country }) => {
        // Remove from waiting queue if already there
        waitingQueue = waitingQueue.filter(u => u.socketId !== socket.id);
        
        if (waitingQueue.length > 0) {
            // Simple match: just pop the first user (can add country filter later)
            const peer = waitingQueue.shift();
            
            activeMatches.set(socket.id, peer.socketId);
            activeMatches.set(peer.socketId, socket.id);

            // Notify both users of the match
            socket.emit('random:match', { peerId: peer.socketId, initiator: true });
            io.to(peer.socketId).emit('random:match', { peerId: socket.id, initiator: false });
        } else {
            // Join queue
            waitingQueue.push({ socketId: socket.id, country: country });
        }
    });

    socket.on('random:leave', () => {
        waitingQueue = waitingQueue.filter(u => u.socketId !== socket.id);
        
        const peerId = activeMatches.get(socket.id);
        if (peerId) {
            activeMatches.delete(socket.id);
            activeMatches.delete(peerId);
            io.to(peerId).emit('random:peer_left');
        }
    });

    socket.on('random:next', ({ country }) => {
        // Leave current match
        const peerId = activeMatches.get(socket.id);
        if (peerId) {
            activeMatches.delete(socket.id);
            activeMatches.delete(peerId);
            io.to(peerId).emit('random:peer_left');
        }
        
        // Rejoin queue
        waitingQueue = waitingQueue.filter(u => u.socketId !== socket.id);
        
        if (waitingQueue.length > 0) {
            const peer = waitingQueue.shift();
            
            activeMatches.set(socket.id, peer.socketId);
            activeMatches.set(peer.socketId, socket.id);

            socket.emit('random:match', { peerId: peer.socketId, initiator: true });
            io.to(peer.socketId).emit('random:match', { peerId: socket.id, initiator: false });
        } else {
            waitingQueue.push({ socketId: socket.id, country: country });
        }
    });

    // -------- WEBRTC SIGNALING --------
    socket.on('call:offer', ({ toSocketId, offer }) => {
        io.to(toSocketId).emit('call:offer', { fromSocketId: socket.id, offer });
    });

    socket.on('call:answer', ({ toSocketId, answer }) => {
        io.to(toSocketId).emit('call:answer', { fromSocketId: socket.id, answer });
    });

    socket.on('call:ice-candidate', ({ toSocketId, candidate }) => {
        io.to(toSocketId).emit('call:ice-candidate', { fromSocketId: socket.id, candidate });
    });

    // -------- DISCONNECT --------
    socket.on('disconnect', () => {
        const userId = activeSockets.get(socket.id);
        if (userId) onlineUsers.delete(userId);
        activeSockets.delete(socket.id);
        
        // Remove from queue
        waitingQueue = waitingQueue.filter(u => u.socketId !== socket.id);
        
        // Disconnect peer if active
        const peerId = activeMatches.get(socket.id);
        if (peerId) {
            activeMatches.delete(socket.id);
            activeMatches.delete(peerId);
            io.to(peerId).emit('random:peer_left');
        }
        
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

