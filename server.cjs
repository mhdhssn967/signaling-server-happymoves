#!/usr/bin/env node

const express = require('express')
const cors = require('cors')
const { WebSocketServer } = require('ws')
const net = require('net')
// const { monitorTransactions } = require('./public/webrtc-client');

const app = express()

// CORS setup
const corsOptions = {
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public')); // Serve static files

// WebSocket bridge (same as before)
const wss = new WebSocketServer({ port: 8080 });
const unityHost = '192.168.1.42';
const unityPort = 8888;

wss.on('connection', function connection(ws) {
  console.log('Browser connected');
  
  const unitySocket = new net.Socket();
  unitySocket.connect(unityPort, unityHost, () => {
    console.log('Connected to Unity server');
    ws.send(JSON.stringify({ type: 'status', data: 'Connected to Unity' }));
  });

  // Forward messages from browser to Unity
  ws.on('message', (data) => {
    console.log('Browser -> Unity:', data.toString());
    unitySocket.write(data + '\n');
  });

// Store message buffers for Unity connections
const unityMessageBuffers = new Map();

// Forward messages from Unity to browser
unitySocket.on('data', (data) => {
    try {
        // Append new data to buffer for this Unity connection
        if (!unityMessageBuffers.has(unitySocket)) {
            unityMessageBuffers.set(unitySocket, '');
        }
        let messageBuffer = unityMessageBuffers.get(unitySocket);
        messageBuffer += data.toString();
        
        // Process complete messages (delimited by newlines)
        let accumulatedData = messageBuffer; // Use let instead of const
        let newlineIndex;
        
        while ((newlineIndex = accumulatedData.indexOf('\n')) >= 0) {
            const completeMessage = accumulatedData.substring(0, newlineIndex);
            accumulatedData = accumulatedData.substring(newlineIndex + 1); // Update accumulatedData
            
            if (completeMessage && completeMessage.trim().length > 0) {
                console.log('Unity -> Browser:');
                
                // Send clean JSON to browser
                try {
                    const parsedMessage = JSON.parse(completeMessage);
                    ws.send(JSON.stringify(parsedMessage));
                } catch (parseError) {
                    console.error('Error parsing JSON from Unity:', parseError);
                    // Send raw message if JSON parsing fails
                    ws.send(completeMessage);
                }
            }
        }
        
        // Update the buffer with remaining data
        unityMessageBuffers.set(unitySocket, accumulatedData);
        
    } catch (error) {
        console.error('Error processing Unity data:', error);
    }
});

  unitySocket.on('close', () => {
    console.log('Unity connection closed');
    ws.close();
  });

  unitySocket.on('error', (err) => {
    console.error('Unity connection error:', err);
    ws.close();
  });

  ws.on('close', () => {
    console.log('Browser disconnected');
    unitySocket.end();
  });
});

// Serve the HTML page
app.get("/", (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log("WebRTC Server running on port " + PORT);
    console.log("WebSocket bridge running on port 8080");
});