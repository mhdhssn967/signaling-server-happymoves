/*
README / Usage
=================
This single-file signaling server uses Node.js + Express + socket.io to provide
lightweight WebRTC signaling for a Unity (Quest) client and a browser client.

Features
- Room-based signaling (multiple rooms / sessions supported)
- Message types: `offer`, `answer`, `ice-candidate`, `join`, `leave`
- Optional simple token-based auth (env var: SIGNALING_SECRET)
- CORS-friendly for deployment with a web app on another origin
- Ready for Render.com deployment

Files included in this doc:
- package.json (snippet)
- server.js (the server implementation below)
- Dockerfile (optional)

How it works (summary)
1. A client connects to the socket.io server.
2. A client joins a room using `join` + { roomId }.
3. When a client (e.g., Unity VR) wants to negotiate, it emits `offer` with
   payload: { roomId, sdp }
4. The server forwards the `offer` to other participants in the same room.
5. The receiver replies with `answer` -> server forwards to that room.
6. ICE candidates are exchanged with `ice-candidate` events.

Security note
- This server is intentionally minimal. For production consider:
  - Enforcing HTTPS / TLS on server (Render provides TLS by default)
  - Adding stronger authentication / authorization per room
  - Rate limiting and logging

Render.com deployment
- Create a new Web Service on Render using this repo.
- Set the start command to: `node server.js`
- Set environment variable PORT (Render sets it automatically), and
  optionally SIGNALING_SECRET

package.json (minimal example)
------------------------------
{
  "name": "webrtc-signaling",
  "version": "1.0.0",
  "main": "server.js",
  "engines": { "node": "18.x" },
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.7.2",
    "cors": "^2.8.5"
  }
}

------------------------------
server.js
------------------------------
*/

/*
  Usage:
    - Install dependencies: npm install
    - Run locally: PORT=8080 node server.js
    - On Render: push repo and set start command to `node server.js`

  Environment variables:
    - PORT (optional) — default 8080
    - SIGNALING_SECRET (optional) — if set, clients must provide this secret
       when joining: { roomId, secret }
*/
import express from "express";
import http from "http";
import { WebSocketServer } from "ws"; // Using the ws library
import cors from "cors";

const SIGNALING_SECRET = process.env.SIGNALING_SECRET || null;
const PORT = process.env.PORT || 8080;

const app = express();

// --- Configuration ---
// Note: WebSocket connections do their handshake over HTTP, so the Express server is still needed.
// The standard ws library handles the protocol upgrade.
const allowedOrigins = [
  "https://oqulix.com",
  "https://ws-receiver-96na.vercel.app",
  "http://127.0.0.1:5500", 'http://127.0.0.1:5501',
  'https://ws-receiver.vercel.app'
];

// Simple CORS setup for the base Express route
app.use(cors({
  origin: (origin, callback) => {
    // Allows requests with no origin (like mobile apps, curl) or allowed origins/netlify
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith("netlify.app")) {
      callback(null, true);
    } else {
      console.warn(`❌ Blocked CORS request from: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

app.get("/", (req, res) => res.send("✅ WebRTC WebSocket Signaling Server is running"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server }); // The WebSocket Server

// In-memory client and room tracking
// Use a WeakMap for clients to allow garbage collection if ws connection is lost unexpectedly
const clients = new Map(); // Key: ws instance, Value: { id: string, roomId: string }
const rooms = new Map(); // Key: roomId, Value: Set<string> (socket IDs)

/**
 * Sends a JSON message to a specific WebSocket connection.
 * @param {import('ws').WebSocket} ws - The target WebSocket.
 * @param {string} type - The event type (e.g., 'offer', 'joined').
 * @param {object} payload - The message payload.
 */
function sendToClient(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    const message = JSON.stringify({ type, payload });
    ws.send(message);
    // console.log(`[WS-Server] Sent '${type}' to ${clients.get(ws)?.id || 'unknown'}: ${message.substring(0, 50)}...`);
  }
}

/**
 * Broadcasts a message to all peers in a specific room, excluding the sender.
 * @param {string} senderId - The ID of the peer sending the message.
 * @param {string} roomId - The room ID.
 * @param {string} type - The event type.
 * @param {object} payload - The message payload.
 * @param {string | undefined} [toSocketId] - Optional target socket ID for unicast.
 */
function broadcast(senderId, roomId, type, payload, toSocketId) {
  if (!rooms.has(roomId)) return;

  const peersInRoom = rooms.get(roomId);

  wss.clients.forEach(ws => {
    // Check if client is open and has joined this room
    if (ws.readyState === ws.OPEN && clients.get(ws)?.roomId === roomId) {
      const clientInfo = clients.get(ws);

      // Check for exclusion (sender) or inclusion (target)
      if (toSocketId) {
        // Unicast: only send if the client is the target
        if (clientInfo.id === toSocketId) {
          sendToClient(ws, type, { from: senderId, ...payload });
        }
      } else if (clientInfo.id !== senderId) {
        // Broadcast: send to all in room except sender
        sendToClient(ws, type, { from: senderId, ...payload });
      }
    }
  });
}

/**
 * Removes a client from the rooms map.
 * @param {string} socketId - The ID of the client.
 * @param {string | undefined} [roomId] - The room ID to check.
 */
function cleanupClient(socketId, roomId) {
  const roomToLeave = roomId || Array.from(rooms.keys()).find(key => rooms.get(key).has(socketId));
  if (roomToLeave) {
    const s = rooms.get(roomToLeave);
    s.delete(socketId);
    console.log(`[WS-Server] Socket ${socketId} left room ${roomToLeave}. Peers remaining: ${s.size}`);

    // Notify remaining peers
    if (s.size > 0) {
      broadcast(socketId, roomToLeave, "peer-left", { socketId });
    }
    if (s.size === 0) {
      rooms.delete(roomToLeave);
    }
  }
}

// --- Handle WebSocket Connections ---
wss.on("connection", (ws, req) => {
  // Generate a unique ID for this WebSocket connection
  const socketId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  clients.set(ws, { id: socketId, roomId: null });

  console.log(`[WS-Server] New connection. Assigned ID: ${socketId}. Total clients: ${wss.clients.size}`);

  // --- Handle Incoming Messages from Unity/Client ---
  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());
      const clientInfo = clients.get(ws);

      if (!msg.type) {
        console.error(`[WS-Server] Invalid message from ${socketId} (missing type field).`);
        return;
      }

      const { type: eventType, ...payload } = msg;

      // Handle the Unity event name mismatch (Unity sends 'ice', server expects 'ice-candidate')
      const signalingEvent = (eventType === 'ice') ? 'ice-candidate' : eventType;

      // --- Signaling Logic ---
      switch (signalingEvent) {
        case 'join':
          {
            const { roomId, secret } = payload;
            if (!roomId) {
              return sendToClient(ws, "error", { message: "roomId required" });
            }
            if (SIGNALING_SECRET && secret !== SIGNALING_SECRET) {
              console.log(`🔴 rejected join for ${socketId} due to wrong secret`);
              return sendToClient(ws, "error", { message: "invalid secret" });
            }

            // 1. Leave any existing room
            cleanupClient(clientInfo.id, clientInfo.roomId);

            // 2. Join the new room
            if (!rooms.has(roomId)) rooms.set(roomId, new Set());
            rooms.get(roomId).add(clientInfo.id);
            clientInfo.roomId = roomId;
            clients.set(ws, clientInfo);

            console.log(`🟢 Socket ${socketId} joined room ${roomId}`);

            // 3. Notify others in the room about the new peer
            broadcast(clientInfo.id, roomId, "peer-joined", { socketId: clientInfo.id });

            // 4. Send back the list of existing participants to the joining peer
            const participants = Array.from(rooms.get(roomId)).filter(id => id !== clientInfo.id);
            sendToClient(ws, "joined", { roomId, participants });
          }
          break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
          {
            const { toSocketId, ...restPayload } = payload;
            const roomId = clientInfo.roomId;
            if (!roomId || !restPayload.sdp && !restPayload.candidate) return;

            // Broadcast/Unicast the SDP/ICE message
            broadcast(clientInfo.id, roomId, signalingEvent, restPayload, toSocketId);
          }
          break;

        case 'leave':
          cleanupClient(clientInfo.id, clientInfo.roomId);
          break;

        default:
          console.warn(`[WS-Server] Unknown event type from ${socketId}: ${eventType}`);
          break;
      }

    } catch (err) {
      console.error("[WS-Server] Error parsing message:", err.message);
    }
  });

  // --- Cleanup ---
  ws.on("close", () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      cleanupClient(clientInfo.id, clientInfo.roomId);
      clients.delete(ws);
      console.log(`[WS-Server] Connection closed for ID: ${clientInfo.id}. Total clients: ${wss.clients.size}`);
    }
  });

  ws.on("error", (err) => {
    console.error("[WS-Server] WebSocket error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 [WS-Server] Server listening on ws://localhost:${PORT}`);
});

/*
Dockerfile (optional)
---------------------
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
*/

/*
Quick client examples (what to give to Unity dev and web dev)
------------------------------------------------------------
- On connect, emit:
  socket.emit('join', { roomId: 'session-123', secret: 'OPTIONAL_SECRET' });

- When Unity creates an offer, send:
  socket.emit('offer', { roomId: 'session-123', sdp: offerSdp });

- When the browser creates an answer, send:
  socket.emit('answer', { roomId: 'session-123', sdp: answerSdp, toSocketId: <unity-socket-id> });

- For ICE candidates, use:
  socket.emit('ice-candidate', { roomId: 'session-123', candidate: candidate, toSocketId: <target-socket-id> });

The server will forward messages to other sockets in the room (or specific target if toSocketId provided).

Notes for Unity developer:
- Use a WebSocket or socket.io-compatible client library inside Unity. There are socket.io client packages available for Unity (C#), or you can use a raw WebSocket and implement a minimal signaling protocol matching the events above.
- Alternatively, use Unity WebRTC examples which show how to exchange SDP via a signaling endpoint.

Notes for web developer:
- Use socket.io-client in the browser and RTCPeerConnection.
- Listen for `offer` event, setRemoteDescription, createAnswer, setLocalDescription, and emit `answer`.
- Relay ICE by sending `ice-candidate` events.
*/
