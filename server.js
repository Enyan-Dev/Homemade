// loading Express package installed
const express = require('express');

//initializing our server application
const app = express();

// Defining port for server listening(locally)
const PORT = 3000;

//Setting up default route
app.get('/', (req, res) => {
    res.send('HOMEMADE Video Chat & Arcade is running!');
});

// Server start
app.listen(PORT, () => {
    console.log('Server running at http://localhost:${PORT}');
});