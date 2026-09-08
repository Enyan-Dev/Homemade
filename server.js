// loading  packages and modules installed
const express = require('express');
const http = require('http');
const {WebSocketServer} = require('ws');

//initializing our server application & defining port
const app = express();
const PORT = 3000;

//Wrapping Express with standard HTTP server & attaching a webSocket server to the http server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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