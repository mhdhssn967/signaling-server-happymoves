const express = require('express')
const cors = require('cors')
const { WebSocketServer } = require('ws')
const net = require('net')

const app = express()

// CORS setup
const corsOptions = {
    // NOTE: For Render, you might need to add your Render domain (e.g., 'https://your-service.onrender.com') 
    // if the web client is hosted separately. Keep localhost for local testing.
    origin: ['http://localhost:3000', 'http://localhost:3001'], 
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public')); // Serve static files

const PORT = process.env.PORT || 3000

// 1. Start the HTTP server (Express) and store the instance
const httpServer = app.listen(PORT, () => {
    console.log(`Web/HTTP Server running on port ${PORT}`);
    console.log(`WebSocket bridge running on the same port.`);
});

// 2. Attach the WebSocket Server to the existing HTTP server instance
// This removes the need for a separate, inaccessible port (8080).
const wss = new WebSocketServer({ server: httpServer });

// Keep message buffers here
const unityMessageBuffers = new Map();

wss.on('connection', (ws) => {
    console.log("Browser connected");

    let unitySocket = null;
    let unityHost = null;
    let unityPort = null;

    ws.on("message", (raw) => {
        let msgString = raw.toString();

        let parsed;
        try {
            parsed = JSON.parse(msgString);
        } catch {
            // Non-JSON message → forward to Unity
            if (unitySocket) unitySocket.write(msgString + "\n");
            return;
        }

        // === FIRST MESSAGE: CONFIG ===
        if (parsed.type === "config") {
            unityHost = parsed.unityHost;
            unityPort = parsed.unityPort;

            console.log("Unity Host set to:", unityHost, "Port:", unityPort);
            ws.send(JSON.stringify({ type: "status", data: "Connecting..." }));

            // Connect to Unity
            unitySocket = new net.Socket();
            unitySocket.connect(unityPort, unityHost, () => {
                console.log("Connected to Unity server");
                ws.send(JSON.stringify({ type: "status", data: "Connected to Unity" }));
            });

            // Handle Unity data
            unitySocket.on("data", (data) => {
                try {
                    let buffer = unityMessageBuffers.get(unitySocket) || "";
                    buffer += data.toString();

                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                        const completeMessage = buffer.substring(0, newlineIndex);
                        buffer = buffer.substring(newlineIndex + 1);

                        if (completeMessage.trim().length > 0) {
                            try {
                                const parsedMessage = JSON.parse(completeMessage);
                                ws.send(JSON.stringify(parsedMessage));
                            } catch {
                                console.error("JSON parse error from Unity, sending raw");
                                ws.send(completeMessage);
                            }
                        }
                    }

                    unityMessageBuffers.set(unitySocket, buffer);
                } catch (error) {
                    console.error("Error processing Unity data:", error);
                }
            });

            unitySocket.on("close", () => {
                console.log("Unity connection closed");
                ws.close();
            });

            unitySocket.on("error", (err) => {
                console.error("Unity connection error:", err);
                ws.send(JSON.stringify({ type: "status", data: "Unity connection failed" }));
            });

            return; // End config section
        }

        // Normal messages → forward to Unity
        if (unitySocket) {
            unitySocket.write(msgString + "\n");
        }
    });

    ws.on("close", () => {
        console.log("Browser disconnected");
        if (unitySocket) unitySocket.end();
        // Clean up buffer map
        unityMessageBuffers.delete(unitySocket);
    });
});

// Serve the HTML page
app.get("/", (req, res) => {
    res.sendFile(__dirname + './index.html');
});