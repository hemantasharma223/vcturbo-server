const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();
const { connectDB, getDb } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Connect to MongoDB
connectDB();

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

// Helper to get collections
const usersCol = () => getDb().collection('users');
const friendsCol = () => getDb().collection('friends');
const messagesCol = () => getDb().collection('messages');

// Upload Route
app.post('/upload', upload.single('profile_pic'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const userId = req.body.userId;

    if (userId) {
        try {
            await usersCol().updateOne(
                { _id: new ObjectId(userId) },
                { $set: { profile_pic: fileUrl } }
            );
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
const activeSockets = new Map(); // socketId -> userId (String)
const onlineUsers = new Map();   // userId (String) -> socketId

// Helper to transform Mongo Doc to Client User Object (id map)
const toClientUser = (doc) => {
    if (!doc) return null;
    return {
        id: doc._id.toString(),
        name: doc.name,
        email: doc.email,
        profile_pic: doc.profile_pic
    };
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- AUTHENTICATION ---
    socket.on('auth:register', async ({ name, email, password }, callback) => {
        try {
            const existing = await usersCol().findOne({ email });
            if (existing) {
                return callback({ success: false, error: "Email already exists" });
            }

            const result = await usersCol().insertOne({
                name,
                email,
                password, // Note: Hash this in production!
                profile_pic: null,
                createdAt: new Date()
            });

            callback({ success: true, userId: result.insertedId.toString() });
        } catch (err) {
            console.error(err);
            callback({ success: false, error: err.message });
        }
    });

    socket.on('auth:login', async ({ email, password }, callback) => {
        try {
            const user = await usersCol().findOne({ email, password });

            if (user) {
                const userId = user._id.toString();

                // CLEAR STALE MAPPINGS
                const prevUserId = activeSockets.get(socket.id);
                if (prevUserId) {
                    onlineUsers.delete(prevUserId);
                }

                const oldSocketId = onlineUsers.get(userId);
                if (oldSocketId && oldSocketId !== socket.id) {
                    console.log(`User ${user.name} replacing socket ${oldSocketId} with ${socket.id}`);
                    activeSockets.delete(oldSocketId);
                }

                activeSockets.set(socket.id, userId);
                onlineUsers.set(userId, socket.id);

                console.log(`User ${user.name} logged in. Total online: ${onlineUsers.size}`);
                callback({ success: true, user: toClientUser(user) });
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
            await usersCol().updateOne(
                { _id: new ObjectId(userId) },
                { $set: { profile_pic: url } }
            );
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

            const regex = new RegExp(query, 'i');
            const users = await usersCol().find({
                $and: [
                    { _id: { $ne: new ObjectId(userId) } },
                    { $or: [{ name: regex }, { email: regex }] }
                ]
            }).limit(20).toArray();

            console.log(`[SEARCH] Found ${users.length} results`);
            callback({ success: true, users: users.map(toClientUser) });
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
            const friend = await usersCol().findOne({ email: toEmail });
            if (!friend) return callback({ success: false, error: "User not found" });

            const friendId = friend._id.toString();
            if (friendId === userId) return callback({ success: false, error: "Cannot add yourself" });

            // Check if request already exists
            const userObjId = new ObjectId(userId);
            const friendObjId = new ObjectId(friendId);

            const existing = await friendsCol().findOne({
                $or: [
                    { requester: userObjId, recipient: friendObjId },
                    { requester: friendObjId, recipient: userObjId }
                ]
            });

            if (existing) {
                if (existing.status === 'accepted') return callback({ success: false, error: "Already friends" });
                return callback({ success: false, error: "Request already pending" });
            }

            await friendsCol().insertOne({
                requester: userObjId,
                recipient: friendObjId,
                status: 'pending',
                createdAt: new Date()
            });

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
        if (!userId) {
            return socket.emit('friend:list:response', { success: false, error: "Not logged in" });
        }

        try {
            const userObjId = new ObjectId(userId);

            // Aggregation to get details for both Sent and Received requests
            const pipeline = [
                {
                    $match: {
                        $or: [{ requester: userObjId }, { recipient: userObjId }]
                    }
                },
                // Lookup requester details
                {
                    $lookup: {
                        from: 'users',
                        localField: 'requester',
                        foreignField: '_id',
                        as: 'requester_info'
                    }
                },
                // Lookup recipient details
                {
                    $lookup: {
                        from: 'users',
                        localField: 'recipient',
                        foreignField: '_id',
                        as: 'recipient_info'
                    }
                },
                { $unwind: { path: '$requester_info', preserveNullAndEmptyArrays: true } },
                { $unwind: { path: '$recipient_info', preserveNullAndEmptyArrays: true } }
            ];

            const friends = await friendsCol().aggregate(pipeline).toArray();

            const mappedFriends = friends.map(f => {
                const isSender = f.requester.toString() === userId;
                // If I am sender, I want recipient info. If I am recipient, I want sender info.
                const otherUser = isSender ? f.recipient_info : f.requester_info;

                if (!otherUser) return null; // Should not happen unless corrupted

                return {
                    id: otherUser._id.toString(),
                    name: otherUser.name,
                    email: otherUser.email,
                    profile_pic: otherUser.profile_pic,
                    status: f.status,
                    is_sender: isSender ? 1 : 0
                };
            }).filter(Boolean);

            socket.emit('friend:list:response', { success: true, friends: mappedFriends });
        } catch (err) {
            console.error('[FRIEND LIST ERROR]', err);
            socket.emit('friend:list:response', { success: false, error: err.message });
        }
    });

    socket.on('friend:respond', async ({ friendId, accept }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) {
            if (typeof callback === 'function') callback({ success: false, error: "Not logged in" });
            return;
        }

        try {
            const userObjId = new ObjectId(userId);
            const friendObjId = new ObjectId(friendId);

            const query = {
                $or: [
                    { requester: friendObjId, recipient: userObjId },
                    { requester: userObjId, recipient: friendObjId }
                ]
            };

            if (accept) {
                await friendsCol().updateOne(query, { $set: { status: 'accepted' } });
            } else {
                await friendsCol().deleteOne(query);
            }

            if (typeof callback === 'function') callback({ success: true });

            // Notify both
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

    async function checkFriendship(userAId, userBId) {
        const count = await friendsCol().countDocuments({
            $or: [
                { requester: new ObjectId(userAId), recipient: new ObjectId(userBId) },
                { requester: new ObjectId(userBId), recipient: new ObjectId(userAId) }
            ],
            status: 'accepted'
        });
        return count > 0;
    }

    // --- CHAT SYSTEM ---
    socket.on('chat:send', async ({ toUserId, message }, callback) => {
        const userId = activeSockets.get(socket.id);
        if (!userId) return callback({ success: false });

        try {
            const isFriend = await checkFriendship(userId, toUserId);
            if (!isFriend) return callback({ success: false, error: "You can only chat with friends." });

            await messagesCol().insertOne({
                sender: new ObjectId(userId),
                receiver: new ObjectId(toUserId),
                content: message,
                timestamp: new Date()
            });

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
            const userObjId = new ObjectId(userId);
            const withUserObjId = new ObjectId(withUserId);

            const messages = await messagesCol().find({
                $or: [
                    { sender: userObjId, receiver: withUserObjId },
                    { sender: withUserObjId, receiver: userObjId }
                ]
            }).sort({ timestamp: 1 }).toArray();

            const clientMessages = messages.map(m => ({
                id: m._id.toString(),
                sender_id: m.sender.toString(),
                receiver_id: m.receiver.toString(),
                message: m.content,
                timestamp: m.timestamp
            }));

            callback({ success: true, messages: clientMessages });
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
