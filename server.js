const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Serve static assets from the public directory
app.use(express.static('public'));

// In-memory store for active rooms
const rooms = new Map();
const ROOM_EXPIRATION_TIME = 15 * 60 * 1000; // 15 Minutes

// Garbage collection for abandoned/expired rooms
setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, roomId) => {
        const isExpired = (now - room.createdAt) > ROOM_EXPIRATION_TIME;
        const isEmpty = room.users.length === 0;

        if (isExpired && isEmpty) {
            rooms.delete(roomId);
            console.log(`Cleaned up expired room: ${roomId}`);
        }
    });
}, 60000);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Broadcasts room state or specific event to all active clients in a given room.
 * @param {string} roomId - Target room ID
 * @param {object} payload - Message object to send
 * @param {WebSocket|null} excludeSocket - Optional socket to exclude from broadcast
 */
function broadcastToRoom(roomId, payload, excludeSocket = null) {
    const room = rooms.get(roomId);
    if (!room) return;

    const message = JSON.stringify(payload);
    room.users.forEach((user) => {
        if (user.socket && user.socket !== excludeSocket && user.socket.readyState === 1) {
            user.socket.send(message);
        }
    });
}

/**
 * Generates public room state object (strips socket references).
 * @param {object} room - Room object
 * @returns {object} Public representation of room state
 */
function getPublicRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return null;

    return {
        roomId: roomId,
        userCount: room.users.length,
        gameState: room.gameState || 'IDLE',
        users: room.users.map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            status: u.status
        }))
    };
}

/**
 * Triggers a full state sync to all active participants in a room.
 * @param {string} roomId 
 */
function syncRoomStateToAll(roomId) {
    const state = getPublicRoomState(roomId);
    if (state) {
        broadcastToRoom(roomId, {
            type: 'room-state-update',
            state: state
        });
    }
}

// --- HTTP ENDPOINTS ---

// Room Creation Endpoint
app.get('/create-room', (req, res) => {
    const roomId = crypto.randomUUID();
    rooms.set(roomId, {
        createdAt: Date.now(),
        users: [],
        gameState: 'IDLE' // Tracks arcade game lifecycle: 'IDLE' | 'PLAYING'
    });
    res.json({
        success: true,
        roomId: roomId,
        roomUrl: `http://localhost:${PORT}/room/${roomId}`
    });
});

// Room Info/Validation Endpoint
app.get('/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    if (!room) {
        return res.status(404).json({
            success: false,
            message: 'Room not found or expired!'
        });
    }
    res.json({
        success: true,
        roomId: roomId,
        createdAt: room.createdAt,
        activeUsers: room.users.length,
        gameState: room.gameState || 'IDLE'
    });
});

app.get('/', (req, res) => {
    res.send('HOMEMADE Video Chat & Arcade is running!');
});

// --- REAL-TIME WEBSOCKET LOGIC ---

wss.on('connection', (socket) => {
    let currentRoomId = null;

    socket.on('message', (rawData) => {
        try {
            const data = JSON.parse(rawData);

            // 1. JOIN ROOM & RECONNECTION HANDLER
            if (data.type === 'join-room') {
                const { roomId, username, userId } = data;

                if (!rooms.has(roomId)) {
                    socket.send(JSON.stringify({ type: 'error', message: 'Room not found or expired!' }));
                    return;
                }

                currentRoomId = roomId;
                const room = rooms.get(roomId);

                // Check if user is reconnecting during grace period
                let existingUser = null;
                if (userId) {
                    existingUser = room.users.find(u => u.id === userId && u.status === 'RECONNECTING');
                }

                if (existingUser) {
                    // Cancel grace period timeout
                    if (existingUser.graceTimer) {
                        clearTimeout(existingUser.graceTimer);
                        existingUser.graceTimer = null;
                    }

                    existingUser.socket = socket;
                    existingUser.status = 'ACTIVE';
                    if (username) existingUser.username = username;

                    // Send re-join confirmation to reconnecting user
                    socket.send(JSON.stringify({
                        type: 'joined',
                        roomId: roomId,
                        userId: existingUser.id,
                        role: existingUser.role,
                        userCount: room.users.length,
                        gameState: room.gameState
                    }));

                    // Sync updated state to all peers
                    syncRoomStateToAll(roomId);
                    return;
                }

                // Enforce room participant limit (Max 8)
                if (room.users.length >= 8) {
                    socket.send(JSON.stringify({ type: 'error', message: 'Room is full! Maximum 8 participants.' }));
                    socket.close();
                    return;
                }

                // Assign primary hot seats before spectator pool
                const activeRoles = room.users.map(u => u.role);
                let assignedRole = 'SPECTATOR';
                if (!activeRoles.includes('HOT_SEAT_P1')) {
                    assignedRole = 'HOT_SEAT_P1';
                } else if (!activeRoles.includes('HOT_SEAT_P2')) {
                    assignedRole = 'HOT_SEAT_P2';
                }

                const userObj = {
                    socket: socket,
                    id: userId || crypto.randomUUID(),
                    username: username || `Guest_${Math.floor(1000 + Math.random() * 9000)}`,
                    role: assignedRole,
                    status: 'ACTIVE',
                    graceTimer: null
                };

                room.users.push(userObj);

                // Send direct join confirmation to new participant
                socket.send(JSON.stringify({
                    type: 'joined',
                    roomId: roomId,
                    userId: userObj.id,
                    role: userObj.role,
                    userCount: room.users.length,
                    gameState: room.gameState
                }));

                // Broadcast updated room state to EVERYONE in the room
                syncRoomStateToAll(roomId);
            }

            // 2. WEBRTC SIGNALING RELAY
            if (data.type === 'signal') {
                if (!currentRoomId || !rooms.has(currentRoomId)) return;
                const room = rooms.get(currentRoomId);

                room.users.forEach((client) => {
                    // Don't echo back to the sender
                    if (client.socket !== socket && client.socket.readyState === 1) {
                        
                        // If sender targeted a specific user ID, only deliver to that user
                        if (data.targetId && client.id !== data.targetId) {
                            return;
                        }

                        client.socket.send(JSON.stringify({
                            type: 'signal',
                            senderId: data.senderId || socket.userId,
                            targetId: data.targetId,
                            signalData: data.signalData
                        }));
                    }
                });
            }

            // 3. ARCADE GAME STATE & CONTROL RELAY
            if (data.type === 'game-state') {
                if (!currentRoomId || !rooms.has(currentRoomId)) return;

                broadcastToRoom(currentRoomId, {
                    type: 'game-state',
                    payload: data.payload
                }, socket);
            }

            if (data.type === 'start-game') {
                if (!currentRoomId || !rooms.has(currentRoomId)) return;
                const room = rooms.get(currentRoomId);

                // Check sender authority
                const sender = room.users.find(u => u.socket === socket);
                if (sender && (sender.role === 'HOT_SEAT_P1' || sender.role === 'HOT_SEAT_P2')) {
                    room.gameState = 'PLAYING';
                    syncRoomStateToAll(currentRoomId);
                }
            }

            if (data.type === 'end-game') {
                if (!currentRoomId || !rooms.has(currentRoomId)) return;
                const room = rooms.get(currentRoomId);

                room.gameState = 'IDLE';
                syncRoomStateToAll(currentRoomId);
            }

        } catch (error) {
            console.error('Invalid JSON received:', error.message);
        }
    });

    // 4. DISCONNECT & FORFEIT MECHANICS
    socket.on('close', () => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        const userIndex = room.users.findIndex(u => u.socket === socket);

        if (userIndex === -1) return;
        const user = room.users[userIndex];

        // Spectators drop immediately without grace period
        if (user.role === 'SPECTATOR') {
            room.users.splice(userIndex, 1);
            syncRoomStateToAll(currentRoomId);
            return;
        }

        // Hot Seat players trigger a 15-second grace period
        user.status = 'RECONNECTING';

        // Notify room of reconnecting status
        broadcastToRoom(currentRoomId, {
            type: 'player-reconnecting',
            username: user.username,
            role: user.role,
            gracePeriodSec: 15
        }, socket);

        user.graceTimer = setTimeout(() => {
            if (user.status === 'RECONNECTING') {
                const droppedRole = user.role;
                const droppedUserId = user.id;
                const updatedRoom = rooms.get(currentRoomId);

                if (updatedRoom) {
                    // Remove forfeited player
                    updatedRoom.users = updatedRoom.users.filter(u => u.id !== user.id);

                    // Promote next active spectator
                    const nextSpectator = updatedRoom.users.find(u => u.role === 'SPECTATOR' && u.status === 'ACTIVE');
                    if (nextSpectator) {
                        nextSpectator.role = droppedRole;
                    }

                    // Reset game state if running
                    if (updatedRoom.gameState === 'PLAYING') {
                        updatedRoom.gameState = 'IDLE';
                    }

                    // Broadcast queue promotion and full room update
                    broadcastToRoom(currentRoomId, {
                        type: 'queue-promoted',
                        vacatedRole: droppedRole,
                        forfeitedUserId: droppedUserId,
                        promotedUser: nextSpectator ? { id: nextSpectator.id, username: nextSpectator.username, role: nextSpectator.role } : null,
                        userCount: updatedRoom.users.length
                    });

                    syncRoomStateToAll(currentRoomId);
                }
            }
        }, 15000);
    });
});

server.listen(PORT, () => {
    console.log(`HOMEMADE server running at http://localhost:${PORT}`);
});