"use strict";

const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const TICK_MS = 50;
const MAX_PLAYERS = 16;
const MOVE_INTERVAL_MS = 1000 / 30;
const HEX_SIZE = 6;
const HEX_SPACING = 1.75;
const ROUND_LENGTH_MS = 70_000;
const COUNTDOWN_MS = 5_000;
const ROUND_BREAK_MS = 6_000;
const rooms = new Map();

const app = express();
const httpServer = http.createServer(app);
const origins = (process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  cors: { origin: origins, methods: ["GET", "POST"] },
  maxHttpBufferSize: 16 * 1024,
});

app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const clientBuild = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuild));
app.get("*", (_req, res, next) => {
  res.sendFile(path.join(clientBuild, "index.html"), (error) => {
    if (error) next();
  });
});

function roomCode(value) {
  if (typeof value !== "string") return "LOBBY";
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{2,12}$/.test(code) ? code : "LOBBY";
}

function playerName(value, socketId) {
  if (typeof value !== "string") return `Player-${socketId.slice(0, 4)}`;
  const name = value.normalize("NFKC")
    .replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 16);
  return name || `Player-${socketId.slice(0, 4)}`;
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      phase: "LOBBY",
      minigame: null,
      round: 0,
      hostId: null,
      phaseEndsAt: 0,
      lastMinigame: null,
      roundParticipants: [],
      tiles: [],
      players: new Map(),
    };
    rooms.set(code, room);
  }
  return room;
}

function serializePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    score: player.score,
    eliminated: player.eliminated,
    finished: player.finished,
  };
}

function snapshot(room, now = Date.now()) {
  return {
    room: room.code,
    phase: room.phase,
    minigame: room.minigame,
    round: room.round,
    roundsTotal: 3,
    hostId: room.hostId,
    secondsLeft: room.phaseEndsAt
      ? Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000))
      : 0,
    tiles: room.tiles.map((tile) => tile.state),
    players: Array.from(room.players.values(), serializePlayer),
  };
}

function sendState(room, now) {
  io.to(room.code).emit("room:state", snapshot(room, now));
}

function setLobbyPositions(room) {
  let index = 0;
  for (const player of room.players.values()) {
    const angle = index * 2.4;
    player.x = Math.cos(angle) * 2;
    player.y = 0;
    player.z = Math.sin(angle) * 2;
    player.yaw = 0;
    player.eliminated = false;
    player.finished = false;
    index++;
  }
}

function startRound(room, now) {
  const choices = ["hex", "race"].filter((game) => game !== room.lastMinigame);
  room.minigame = choices[Math.floor(Math.random() * choices.length)] || "hex";
  room.lastMinigame = room.minigame;
  room.round += 1;
  room.phase = "COUNTDOWN";
  room.phaseEndsAt = now + COUNTDOWN_MS;
  room.firstFinisher = null;
  room.roundParticipants = Array.from(room.players.keys());
  room.tiles = room.minigame === "hex"
    ? Array.from({ length: HEX_SIZE * HEX_SIZE }, () => ({ state: "ready", breaksAt: 0 }))
    : [];

  let index = 0;
  for (const id of room.roundParticipants) {
    const player = room.players.get(id);
    if (!player) continue;
    player.x = (index % 4 - 1.5) * 1.5;
    player.y = 0;
    player.z = room.minigame === "race" ? 9 : (Math.floor(index / 4) - 1) * 1.1;
    player.yaw = 0;
    player.eliminated = false;
    player.finished = false;
    index++;
  }
}

function endRound(room, winnerId, now) {
  if (room.phase !== "ACTIVE") return;
  if (winnerId && room.players.has(winnerId)) room.players.get(winnerId).score += 5;
  room.phase = "ROUND_OVER";
  room.phaseEndsAt = now + ROUND_BREAK_MS;
}

function startGame(socket, room) {
  if (socket.id !== room.hostId || room.phase !== "LOBBY" || room.players.size === 0) return;
  room.round = 0;
  room.lastMinigame = null;
  for (const player of room.players.values()) player.score = 0;
  startRound(room, Date.now());
  sendState(room, Date.now());
}

function hexTileAt(x, z) {
  const col = Math.round(x / HEX_SPACING + (HEX_SIZE - 1) / 2);
  const row = Math.round(z / HEX_SPACING + (HEX_SIZE - 1) / 2);
  if (col < 0 || col >= HEX_SIZE || row < 0 || row >= HEX_SIZE) return -1;
  const centerX = (col - (HEX_SIZE - 1) / 2) * HEX_SPACING;
  const centerZ = (row - (HEX_SIZE - 1) / 2) * HEX_SPACING;
  if (Math.abs(x - centerX) > 0.95 || Math.abs(z - centerZ) > 0.95) return -1;
  return row * HEX_SIZE + col;
}

function activePlayers(room) {
  return room.roundParticipants
    .map((id) => room.players.get(id))
    .filter(Boolean);
}

function advanceRoom(room, now) {
  if (room.phase === "COUNTDOWN" && now >= room.phaseEndsAt) {
    room.phase = "ACTIVE";
    room.phaseEndsAt = now + ROUND_LENGTH_MS;
  } else if (room.phase === "ACTIVE") {
    const participants = activePlayers(room);

    if (room.minigame === "hex") {
      for (const tile of room.tiles) {
        if (tile.state === "cracking" && now >= tile.breaksAt) tile.state = "gone";
      }

      for (const player of participants) {
        if (player.eliminated) continue;
        if (player.y < -2 || Math.abs(player.x) > 6 || Math.abs(player.z) > 6) {
          player.eliminated = true;
          continue;
        }
        if (player.y <= 1.25) {
          const index = hexTileAt(player.x, player.z);
          const tile = room.tiles[index];
          if (tile && tile.state === "ready") {
            tile.state = "cracking";
            tile.breaksAt = now + 1000;
          } else if (tile && tile.state === "gone") {
            player.eliminated = true;
          }
        }
      }

      const alive = participants.filter((player) => !player.eliminated);
      if (participants.length > 1 && alive.length <= 1) {
        endRound(room, alive[0] && alive[0].id, now);
      } else if (now >= room.phaseEndsAt) {
        const winner = alive.sort((a, b) => b.y - a.y)[0];
        endRound(room, winner && winner.id, now);
      }
    } else {
      for (const player of participants) {
        if (!player.eliminated && !player.finished && player.z <= -25) {
          player.finished = true;
          if (!room.firstFinisher) {
            room.firstFinisher = player.id;
            player.score += 5;
          }
        }
      }
      const allFinished = participants.length > 0 && participants.every((player) => player.finished || player.eliminated);
      if (allFinished || now >= room.phaseEndsAt) {
        if (now >= room.phaseEndsAt && !room.firstFinisher) {
          const furthest = participants
            .filter((player) => !player.eliminated)
            .sort((a, b) => a.z - b.z)[0];
          if (furthest) furthest.score += 5;
        }
        room.phase = "ROUND_OVER";
        room.phaseEndsAt = now + ROUND_BREAK_MS;
      }
    }
  } else if (room.phase === "ROUND_OVER" && now >= room.phaseEndsAt) {
    if (room.round >= 3) {
      room.phase = "PODIUM";
      room.phaseEndsAt = 0;
      const ranked = Array.from(room.players.values()).sort((a, b) => b.score - a.score);
      ranked.forEach((player, index) => {
        const places = [
          { x: 0, y: 2.4 },
          { x: -3.1, y: 1.6 },
          { x: 3.1, y: 1.15 },
        ];
        const place = places[index] || { x: (index - 2) * 1.5, y: 0 };
        player.x = place.x;
        player.y = place.y;
        player.z = -1.5;
      });
    } else {
      startRound(room, now);
    }
  }
}

io.on("connection", (socket) => {
  const auth = socket.handshake.auth || {};
  const code = roomCode(auth.room);
  const room = getRoom(code);

  if (room.players.size >= MAX_PLAYERS) {
    socket.emit("room:error", { message: "La sala está llena." });
    socket.disconnect(true);
    return;
  }

  const player = {
    id: socket.id,
    name: playerName(auth.name, socket.id),
    x: 0, y: 0, z: 0, yaw: 0,
    score: 0, eliminated: false, finished: false,
    lastMoveAt: 0,
  };
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  if (room.phase === "LOBBY") setLobbyPositions(room);
  socket.join(code);
  socket.data.roomCode = code;
  socket.emit("room:joined", { ...snapshot(room), selfId: player.id });
  socket.to(code).emit("room:player-joined", { player: serializePlayer(player), hostId: room.hostId });

  socket.on("room:start", () => startGame(socket, room));
  socket.on("room:restart", () => {
    if (socket.id !== room.hostId || room.phase !== "PODIUM") return;
    room.phase = "LOBBY";
    room.minigame = null;
    room.round = 0;
    room.phaseEndsAt = 0;
    room.firstFinisher = null;
    room.tiles = [];
    room.roundParticipants = [];
    for (const player of room.players.values()) player.score = 0;
    setLobbyPositions(room);
  });

  socket.on("player:move", (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const { x, y, z, yaw } = input;
    if (![x, y, z, yaw].every(Number.isFinite)) return;
    const now = Date.now();
    if (now - player.lastMoveAt < MOVE_INTERVAL_MS) return;
    player.lastMoveAt = now;

    if (room.phase === "ACTIVE" && (player.eliminated || player.finished)) return;
    const minX = room.minigame === "race" ? -5.5 : -8;
    const maxX = room.minigame === "race" ? 5.5 : 8;
    const minZ = room.minigame === "race" ? -30 : -8;
    const maxZ = room.minigame === "race" ? 14 : 8;
    player.x = Math.max(minX, Math.min(maxX, x));
    player.y = Math.max(-5, Math.min(12, y));
    player.z = Math.max(minZ, Math.min(maxZ, z));
    player.yaw = Math.max(-Math.PI, Math.min(Math.PI, yaw));
  });

  socket.on("disconnect", () => {
    const current = rooms.get(socket.data.roomCode);
    if (!current) return;
    current.players.delete(socket.id);
    current.roundParticipants = current.roundParticipants.filter((id) => id !== socket.id);
    if (current.firstFinisher === socket.id) current.firstFinisher = null;
    if (current.players.size === 0) {
      rooms.delete(current.code);
      return;
    }
    if (current.hostId === socket.id) {
      current.hostId = current.players.keys().next().value;
      io.to(current.code).emit("room:host-changed", { hostId: current.hostId });
    }
    if (current.phase === "LOBBY") setLobbyPositions(current);
  });
});

const ticker = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    advanceRoom(room, now);
    sendState(room, now);
  }
}, TICK_MS);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Party Arena listo en http://localhost:${PORT}`);
});

function shutdown() {
  clearInterval(ticker);
  io.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
