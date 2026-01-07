const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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

// State
let waitingQueue = [];
const activeSockets = new Map(); // socketId -> userId (INT)
const onlineUsers = new Map();   // userId (INT) -> socketId

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- AUTHENTICATION ---
    socket.on('auth:register', async ({ name, email, password }, callback) => {
        try {
            const [result] = await db.query(
                'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
                [name, email, password] // Plain text for MVP as requested
            );
            callback({ success: true, userId: result.insertId });
        } catch (err) {
            console.error(err);
            callback({ success: false, error: err.message });
        }
    });

    socket.on('auth:login', async ({ email, password }, callback) => {
        try {
            const [rows] = await db.query(
                'SELECT * FROM users WHERE email = ? AND password = ?',
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

    // --- FRIEND SYSTEM ---
    socket.on('friend:request', async ({ toEmail }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false, error: "Not logged in" });

        try {
            const [users] = await db.query('SELECT id FROM users WHERE email = ?', [toEmail]);
            if (users.length === 0) return callback({ success: false, error: "User not found" });

            const friendId = users[0].id;
            if (friendId === userId) return callback({ success: false, error: "Cannot add yourself" });

            await db.query(
                'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
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
            const [sent] = await db.query(`
                SELECT u.id, u.name, u.email, f.status 
                FROM friends f 
                JOIN users u ON f.friend_id = u.id 
                WHERE f.user_id = ?`, [userId]);

            // Get friends where user is receiver
            const [received] = await db.query(`
                SELECT u.id, u.name, u.email, f.status 
                FROM friends f 
                JOIN users u ON f.user_id = u.id 
                WHERE f.friend_id = ?`, [userId]);

            callback({ success: true, friends: [...sent, ...received] });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('friend:accept', async ({ requestId }, callback) => {
        // requestId could be the id of the friend relationship or the friend's user_id
        // Let's assume input is friend_id (the user who sent the request)
        const userId = activeSockets.get(socket.id);
        // We need to update the row where user_id = friend_id AND friend_id = userId
    });

    // Correcting accept logic to be simpler: receive friendId
    socket.on('friend:respond', async ({ friendId, accept }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return;

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
            callback({ success: true });
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    // --- CHAT SYSTEM ---
    socket.on('chat:send', async ({ toUserId, message }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false });

        try {
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
            const [rows] = await db.query(`
                SELECT * FROM messages 
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
    socket.on('call:request', ({ toUserId, offer }) => {
        const userId = activeSockets.get(socket.id);
        const targetSocket = onlineUsers.get(toUserId);

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

    // --- EXISTING RANDOM VIDEO CHAT ---
    socket.on('join', () => {
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        waitingQueue.push(socket.id);
        console.log(`User ${socket.id} joined random queue.`);

        if (waitingQueue.length >= 2) {
            const user1 = waitingQueue.shift();
            const user2 = waitingQueue.shift();
            io.to(user1).emit('match', { peerId: user2, initiator: true });
            io.to(user2).emit('match', { peerId: user1, initiator: false });
        }
    });

    // Reuse existing WebRTC events for RANDOM chat (peerId based)
    socket.on('offer', (data) => io.to(data.to).emit('offer', { from: socket.id, offer: data.offer }));
    socket.on('answer', (data) => io.to(data.to).emit('answer', { from: socket.id, answer: data.answer }));
    socket.on('ice-candidate', (data) => io.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate }));

    socket.on('leave', (data) => {
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (data && data.to) io.to(data.to).emit('user-left', { from: socket.id });
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
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
