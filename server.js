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
import { Server } from "socket.io";
import cors from "cors";

const SIGNALING_SECRET = process.env.SIGNALING_SECRET || null;

const app = express();

// ✅ Allowed client origins (add more as needed)
const allowedOrigins = [
  "https://clinquant-praline-1faed4.netlify.app",
  "https://stunning-pastelito-bda24e.netlify.app",
  "https://oqulix.com",
  "https://your-production-site.com",
  "http://127.0.0.1:5500"
];

// ✅ CORS setup for Express routes
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith("netlify.app")) {
      callback(null, true);
    } else {
      console.warn(`❌ Blocked CORS request from: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"],
  credentials: true
}));

app.get("/", (req, res) => res.send("✅ WebRTC Signaling Server is running"));

const server = http.createServer(app);

// ✅ CORS setup for Socket.IO
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith("netlify.app")) {
        callback(null, true);
      } else {
        console.warn(`❌ Blocked socket connection from: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"]
  },
  pingTimeout: 30000,
});

// In-memory room tracking
const rooms = new Map();

function joinRoom(roomId, socketId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(socketId);
}
function leaveRoom(roomId, socketId) {
  if (!rooms.has(roomId)) return;
  const s = rooms.get(roomId);
  s.delete(socketId);
  if (s.size === 0) rooms.delete(roomId);
}

io.on("connection", (socket) => {
  console.log("🟢 socket connected:", socket.id);

  socket.on("join", (data) => {
    try {
      const { roomId, secret } = data || {};
      if (!roomId) return socket.emit("error", { message: "roomId required" });
      if (SIGNALING_SECRET && secret !== SIGNALING_SECRET) {
        console.log("🔴 rejected join due to wrong secret", socket.id);
        return socket.emit("error", { message: "invalid secret" });
      }

      socket.join(roomId);
      joinRoom(roomId, socket.id);
      console.log(`🟢 socket ${socket.id} joined room ${roomId}`);

      socket.to(roomId).emit("peer-joined", { socketId: socket.id });
      const participants = Array.from(rooms.get(roomId) || []).filter(id => id !== socket.id);
      socket.emit("joined", { roomId, participants });
    } catch (err) {
      console.error('join error', err);
      socket.emit("error", { message: "join failed" });
    }
  });

  socket.on("offer", ({ roomId, sdp, toSocketId }) => {
    if (!roomId || !sdp) return;
    if (toSocketId) io.to(toSocketId).emit("offer", { from: socket.id, sdp });
    else socket.to(roomId).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ roomId, sdp, toSocketId }) => {
    if (!roomId || !sdp) return;
    if (toSocketId) io.to(toSocketId).emit("answer", { from: socket.id, sdp });
    else socket.to(roomId).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ roomId, candidate, toSocketId }) => {
    if (!roomId || !candidate) return;
    if (toSocketId) io.to(toSocketId).emit("ice-candidate", { from: socket.id, candidate });
    else socket.to(roomId).emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.on("leave", ({ roomId }) => {
    if (roomId) {
      leaveRoom(roomId, socket.id);
      socket.leave(roomId);
      socket.to(roomId).emit("peer-left", { socketId: socket.id });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("🔌 socket disconnected", socket.id, reason);
    for (const [roomId, set] of rooms.entries()) {
      if (set.has(socket.id)) {
        leaveRoom(roomId, socket.id);
        socket.to(roomId).emit("peer-left", { socketId: socket.id });
      }
    }
  });

  socket.on("error", (err) => {
    console.error("⚠️ socket error", err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Signaling server listening on port ${PORT}`);
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
