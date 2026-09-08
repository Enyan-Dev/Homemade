// loading  packages and modules installed
const express = require('express');
const http = require('http');
const {WebSocketServer} = require('ws');
const crypto = require('crypto'); //Random ID generator

//initializing our server application & defining port
const app = express();
const PORT = 3000;

//store active rooms in memory: Key = roomId, Value = Room Object
const rooms = new Map();

//ROOM CLEANUP
const ROOM_EXPIRATION_TIME = 15 * 60 * 1000; //15 mins in milliseconds (15 * 60secs * 1000ms)
//Run cleanup every 1 minute (60,000 ms)
setInterval(() => {
    const now = Date.now();
    // Iterate through every active room in the Map
    rooms.forEach((room, roomId) => {
        const isExpired = (now - room.createdAt) > ROOM_EXPIRATION_TIME;
        const isEmpty = room.users.lenght === 0;

        //Delete room if older than 15 mins AND no active users remain
        if (isExpired && isEmpty) {
            rooms.delete(roomId);
            console.log(`Cleaned up expired room: ${roomId}`);
        }
    });
}, 60000);

//Wrapping Express with standard HTTP server & attaching a webSocket server to the http server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

//route to create a new unique HOMEMADE room link
app.get('/create-room', (req, res) => {
    //-Generate a a unique 36-character ID (e.g. "123e4567-e89b-12d3-a456-426614174000")
    const roomId = crypto.randomUUID();
    //-Save the new room into the rooms Map
    rooms.set(roomId, {
        createdAt: Date.now(),
        users: []
    });
    //-Send room details back to the user
    res.json({
        success: true,
        roomId: roomId,
        roomUrl: `http://localhost:${PORT}/room/${roomId}`
    });
});

//Route to check if a specific room exists
app.get('/room/:roomId', (req, res) => {
    //-extract the roomId parameter from the URL path
    const roomId = req.params.roomId;
    // room lookup in memory Map
    const room = rooms.get(roomId);
    //-room verification(if room not in memory, send a 404 error)
    if(!room) {
        return res.status(404).json({
            success: false,
            message: 'Room not found or has expired!'
        });
    }
    //- If room exists, send back room details
    res.json({
        success: true,
        roomId: roomId,
        createdAt: room.createdAt,
        activeUsers: room.users.lenght
    });
});

//Defining default route
app.get('/', (req, res) => {
    res.send('HOMEMADE Video Chat & Arcade is running!');
});

// listen for incoming WebSocket connections
wss.on('connection', (socket) => {
    console.log('A new user connected via WebSocket!');
   
    // Listen for messages sent by this client
    socket.on('message', (message) => {
        console.log('Received:', message.toString());
    });

    //Handle user disconnect
    socket.on('close', () => {
        console.log('User disconnected.');
    });
});
// Server start(using 'server.listen' )
server.listen(PORT, () => {
    console.log(`HOMEMADE server running at http://localhost:${PORT}`);
});