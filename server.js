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
import { WebSocketServer } from "ws";
import cors from "cors";

const SIGNALING_SECRET = process.env.SIGNALING_SECRET || null;
const PORT = process.env.PORT || 8080;

const app = express();

const allowedOrigins = [
  "https://oqulix.com",
  "https://ws-receiver-96na.vercel.app",
  "https://ws-receiver.vercel.app",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:5501",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith("netlify.app")) {
      callback(null, true);
    } else {
      console.warn(`❌ Blocked CORS request from: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

app.get("/", (req, res) => res.send("✅ WebRTC Signaling Server (Unity-compatible) is running."));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();
const rooms = new Map();

function sendToClient(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcast(senderId, roomId, type, payload, toSocketId) {
  if (!rooms.has(roomId)) return;
  wss.clients.forEach(ws => {
    const info = clients.get(ws);
    if (!info || info.roomId !== roomId || ws.readyState !== ws.OPEN) return;

    if (toSocketId) {
      if (info.id === toSocketId) sendToClient(ws, type, { from: senderId, ...payload });
    } else if (info.id !== senderId) {
      sendToClient(ws, type, { from: senderId, ...payload });
    }
  });
}

function cleanupClient(socketId, roomId) {
  const targetRoom = roomId || Array.from(rooms.keys()).find(r => rooms.get(r).has(socketId));
  if (!targetRoom || !rooms.has(targetRoom)) return;

  const peers = rooms.get(targetRoom);
  peers.delete(socketId);
  console.log(`[WS] Client ${socketId} left room ${targetRoom}. Remaining: ${peers.size}`);

  if (peers.size > 0) broadcast(socketId, targetRoom, "peer-left", { socketId });
  else rooms.delete(targetRoom);
}

wss.on("connection", (ws, req) => {
  const socketId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const userAgent = req.headers["user-agent"] || "";
  const isUnity = /unity|csharp|mono/i.test(userAgent);

  clients.set(ws, { id: socketId, roomId: null, isUnity });

  console.log(`🟢 [${isUnity ? "Unity" : "Web"}] Connected: ${socketId} (${wss.clients.size} total)`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const client = clients.get(ws);
      if (!msg.type) return;

      // Normalize event type
      const eventType = (msg.type === "ice") ? "ice-candidate" : msg.type;

      // --- 🧠 FIX: Support Unity's structure ---
      const roomId = msg.roomId || msg.to || msg.room;
      const toSocketId = msg.toSocketId || null;
      const payload = msg.payload || msg;

      switch (eventType) {
        case "join": {
          if (!roomId) return sendToClient(ws, "error", { message: "roomId required" });
          if (SIGNALING_SECRET && msg.secret !== SIGNALING_SECRET) {
            return sendToClient(ws, "error", { message: "invalid secret" });
          }

          cleanupClient(client.id, client.roomId);
          if (!rooms.has(roomId)) rooms.set(roomId, new Set());
          rooms.get(roomId).add(client.id);
          client.roomId = roomId;

          console.log(`📡 [${client.isUnity ? "Unity" : "Web"}] ${client.id} joined room ${roomId}`);

          broadcast(client.id, roomId, "peer-joined", { socketId: client.id });
          const existingPeers = Array.from(rooms.get(roomId)).filter(id => id !== client.id);
          sendToClient(ws, "joined", { roomId, participants: existingPeers });
          break;
        }

        case "offer":
case "answer":
case "ice-candidate": {
  // 🧠 Use client.roomId OR fallback to msg.to/msg.room
  const targetRoom = client.roomId || msg.to || msg.room;
  if (!targetRoom) {
    console.warn(`[WS] ${eventType} missing roomId from ${client.id}`);
    return;
  }

  let finalPayload = payload;

  // Normalize Unity ICE payload
  if (eventType === "ice-candidate") {
    const candidateObj =
      msg.payload?.candidate?.candidate || msg.payload?.candidate;
    const sdpMid =
      msg.payload?.candidate?.sdpMid || msg.payload?.sdpMid;
    const sdpMLineIndex =
      msg.payload?.candidate?.sdpMLineIndex || msg.payload?.sdpMLineIndex;

    if (candidateObj) {
      finalPayload = { candidate: candidateObj, sdpMid, sdpMLineIndex };
    }
  }

  broadcast(client.id, targetRoom, eventType, finalPayload, toSocketId);
  break;
}


        case "leave":
          cleanupClient(client.id, client.roomId);
          client.roomId = null;
          break;

        default:
          console.warn(`[WS] Unknown event '${eventType}' from ${client.id}`);
      }
    } catch (err) {
      console.error("[WS] Error parsing message:", err.message);
    }
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (!info) return;
    cleanupClient(info.id, info.roomId);
    clients.delete(ws);
    console.log(`🔴 Disconnected: ${info.id} (${info.isUnity ? "Unity" : "Web"})`);
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});

server.listen(PORT, () => {
  console.log(`🚀 [Signaling] Server ready on ws://localhost:${PORT}`);
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
