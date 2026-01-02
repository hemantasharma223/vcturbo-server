const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let waitingQueue = [];

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', () => {
        // If user is already in queue or valid, ignore or reset?
        // Simple MVP: Just push to queue if not matching
        
        // Remove from queue if present (re-joining)
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        waitingQueue.push(socket.id);
        console.log(`User ${socket.id} joined queue. Queue length: ${waitingQueue.length}`);

        if (waitingQueue.length >= 2) {
            // Match the first two users
            const user1 = waitingQueue.shift();
            const user2 = waitingQueue.shift();

            // Notify both users
            io.to(user1).emit('match', { peerId: user2, initiator: true });
            io.to(user2).emit('match', { peerId: user1, initiator: false });

            console.log(`Matched ${user1} with ${user2}`);
        }
    });

    socket.on('offer', (data) => {
        // data: { to: peerId, offer: rtcOffer }
        console.log(`Offer from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('offer', { from: socket.id, offer: data.offer });
    });

    socket.on('answer', (data) => {
        // data: { to: peerId, answer: rtcAnswer }
        console.log(`Answer from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('answer', { from: socket.id, answer: data.answer });
    });

    socket.on('ice-candidate', (data) => {
        // data: { to: peerId, candidate: rtcCandidate }
        console.log(`ICE Candidate from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate });
    });

    socket.on('leave', (data) => {
        // data can be peerId if provided, or just cleanup
        // If in queue, remove
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        // Notify peer if in call (client should send 'to' or we maintain state map)
        // For MVP stateless simple: client sends 'leave' to peer via signaling if they know it
        if (data && data.to) {
            io.to(data.to).emit('user-left', { from: socket.id });
        }
        console.log(`User ${socket.id} left/next`);
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        // Ideally notify peer, but we don't track state on server for MVP simplicity 
        // unless we add a `socket.peerId` property.
        // Let's rely on WebRTC connection failure or client 'leave' for now, 
        // OR add simple state.
        // Let's add simple state to be robust.
        console.log('User disconnected:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
