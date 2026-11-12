import "./style.css";
import * as THREE from "three";
import { io } from "socket.io-client";

const $ = (id) => document.getElementById(id);
const canvas = $("game");
const joinForm = $("join-form");
const joinCard = $("join-card");
const lobbyCard = $("lobby-card");
const startButton = $("start-button");
const toastEl = $("toast");
const roundLabels = {
  hex: "SUELO QUE CAE",
  race: "CARRERA DE OBSTÁCULOS",
};
const palette = [0xff647c, 0x5bc0eb, 0xffc857, 0x7de2a8, 0xb48cff, 0xff8f5c, 0x67d5c1, 0xf57bb4];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9bbbe0);
scene.fog = new THREE.Fog(0x9bbbe0, 35, 95);
const camera = new THREE.PerspectiveCamera(54, innerWidth / innerHeight, 0.1, 150);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

scene.add(new THREE.HemisphereLight(0xe4f3ff, 0x53627d, 2.1));
const sun = new THREE.DirectionalLight(0xffedcf, 2.5);
sun.position.set(-12, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536);
scene.add(sun);

const world = new THREE.Group();
scene.add(world);
const avatarLayer = new THREE.Group();
scene.add(avatarLayer);
const avatars = new Map();
let socket = null;
let selfId = null;
let roomState = null;
let worldMode = null;
let lastPhase = "";
let lastRound = 0;
let toastTimeout = 0;
let cameraYaw = 0;
let cameraPitch = 0.34;
let dragging = false;
let pointerX = 0;
let pointerY = 0;
let lastFrame = performance.now();
let sendElapsed = 0;
let jumpVelocity = 0;
let jumpPressed = false;
let lastJumpDown = false;
let local = { x: 0, y: 0, z: 0, yaw: 0 };
const keys = new Set();
const tileMeshes = [];
const movingObstacles = [];

function material(color, roughness = 0.72) {
  return new THREE.MeshStandardMaterial({ color, roughness });
}

function clearWorld() {
  world.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      const list = Array.isArray(object.material) ? object.material : [object.material];
      list.forEach((item) => item.dispose());
    }
  });
  world.clear();
  tileMeshes.length = 0;
  movingObstacles.length = 0;
}

function box(parent, width, height, depth, color, x, y, z, options = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    material(color, options.roughness ?? 0.72),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = options.shadow !== false;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeFloor(width, depth, color, x = 0, z = 0) {
  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, depth), material(color));
  floor.position.set(x, -0.34, z);
  floor.receiveShadow = true;
  world.add(floor);
  return floor;
}

function buildLobby() {
  makeFloor(22, 22, 0x554b89);
  box(world, 20, 0.16, 20, 0x7867b6, 0, -0.02, -0.02);
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const rail = box(world, 20, 0.4, 0.38, 0x9a8bdf, Math.cos(angle) * 9.8, 0.28, Math.sin(angle) * 9.8);
    rail.rotation.y = -angle;
  }
  for (let i = 0; i < 18; i++) {
    const angle = i * Math.PI * 2 / 18;
    const star = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.55, 5), material(i % 2 ? 0x9d8aff : 0x70e8cf));
    star.position.set(Math.cos(angle) * 8.6, 0.68, Math.sin(angle) * 8.6);
    star.castShadow = true;
    world.add(star);
  }
  for (let i = 0; i < 8; i++) {
    const cloud = new THREE.Mesh(new THREE.DodecahedronGeometry(1.3 + (i % 3) * 0.35, 0), material(i % 2 ? 0xc3d1ec : 0xb2c5e5));
    const a = i * 0.79;
    cloud.position.set(Math.cos(a) * 21, 6 + (i % 3), Math.sin(a) * 21);
    world.add(cloud);
  }
}

function buildHex() {
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const tile = new THREE.Mesh(
        new THREE.CylinderGeometry(0.98, 0.98, 0.38, 6),
        material(palette[(row * 6 + col) % palette.length]),
      );
      tile.position.set((col - 2.5) * 1.75, -0.1, (row - 2.5) * 1.75);
      tile.rotation.y = Math.PI / 6;
      tile.castShadow = true;
      tile.receiveShadow = true;
      tile.userData.baseColor = palette[(row * 6 + col) % palette.length];
      world.add(tile);
      tileMeshes.push(tile);
    }
  }
  const railColor = 0x344268;
  box(world, 11, 0.45, 0.4, railColor, 0, -0.1, -5.7);
  box(world, 11, 0.45, 0.4, railColor, 0, -0.1, 5.7);
}

function buildRace() {
  makeFloor(13, 44, 0x586783, 0, -8);
  for (const x of [-6.4, 6.4]) box(world, 0.5, 1, 44, 0x323d59, x, 0.35, -8);
  for (let z = 10; z >= -26; z -= 4) {
    box(world, 11, 0.08, 0.11, z % 8 ? 0xffffff : 0x72efcf, 0, -0.05, z);
  }
  for (const z of [1, -8, -16]) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 11.6, 10), material(0xff7185));
    roller.rotation.z = Math.PI / 2;
    roller.position.set(0, 0.62, z);
    roller.castShadow = true;
    roller.userData.kind = "roller";
    world.add(roller);
    movingObstacles.push(roller);
  }
  for (const [i, z] of [-4, -12, -21].entries()) {
    const block = box(world, 1.8, 1.45, 1.7, i % 2 ? 0xffc857 : 0x7c71ff, 0, 0.45, z);
    block.userData.kind = "block";
    block.userData.originX = i % 2 ? -3.4 : 3.4;
    block.userData.phase = i * 1.7;
    movingObstacles.push(block);
  }
  box(world, 12.6, 0.18, 0.55, 0x74f0cf, 0, 0.15, -25.5);
}

function buildPodium() {
  makeFloor(22, 18, 0x343b69);
  const podiums = [
    { x: 0, h: 2.5, color: 0xf2c85b },
    { x: -3.1, h: 1.7, color: 0xc7d2e6 },
    { x: 3.1, h: 1.25, color: 0xc98a59 },
  ];
  for (const p of podiums) {
    const stand = box(world, 2.7, p.h, 2.7, p.color, p.x, p.h / 2 - 0.1, -1.5);
    stand.material.roughness = 0.4;
  }
}

function buildWorld(mode) {
  if (worldMode === mode) return;
  worldMode = mode;
  clearWorld();
  if (mode === "hex") buildHex();
  else if (mode === "race") buildRace();
  else if (mode === "PODIUM") buildPodium();
  else buildLobby();
}

function makeLabel(name, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  context.fillStyle = "#10182b";
  context.beginPath();
  context.roundRect(16, 8, 224, 48, 16);
  context.fill();
  context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  context.font = "700 24px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(name.slice(0, 16), 128, 33);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(2.2, 0.55, 1);
  sprite.position.y = 2.05;
  return sprite;
}

function createAvatar(player) {
  const group = new THREE.Group();
  const color = palette[Math.abs(hash(player.id)) % palette.length];
  const bodyMat = material(color, 0.4);
  const white = material(0xffffff, 0.35);
  const dark = material(0x20243b, 0.4);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.62, 4, 8), bodyMat);
  body.position.y = 0.68;
  body.castShadow = true;
  group.add(body);
  const eye1 = new THREE.Mesh(new THREE.SphereGeometry(0.095, 8, 8), white);
  const eye2 = eye1.clone();
  eye1.position.set(-0.15, 1.25, -0.36);
  eye2.position.set(0.15, 1.25, -0.36);
  group.add(eye1, eye2);
  for (const x of [-0.15, 0.15]) {
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), dark);
    pupil.position.set(x, 1.24, -0.44);
    group.add(pupil);
  }
  group.add(makeLabel(player.name, color));
  avatarLayer.add(group);
  return { group, target: { x: player.x, y: player.y, z: player.z, yaw: player.yaw }, color };
}

function hash(value) {
  let result = 0;
  for (let i = 0; i < value.length; i++) result = (result * 31 + value.charCodeAt(i)) | 0;
  return result;
}

function updateTileState(states = []) {
  states.forEach((state, index) => {
    const tile = tileMeshes[index];
    if (!tile) return;
    if (state === "gone") {
      tile.visible = false;
    } else if (state === "cracking") {
      tile.visible = true;
      tile.material.color.setHex(0xf8f2d2);
    } else {
      tile.visible = true;
      tile.material.color.setHex(tile.userData.baseColor);
    }
  });
}

function renderScoreboard(players = []) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  $("score-list").innerHTML = sorted.map((p, index) =>
    `<div class="score-row"><span>${index + 1}. ${escapeText(p.name)}${p.id === selfId ? " (tú)" : ""}</span><span>${p.score} pt</span></div>`
  ).join("");
}

function escapeText(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove("show"), 2300);
}

function updateUI(state) {
  roomState = state;
  const mode = state.phase === "PODIUM" ? "PODIUM" : (state.minigame || "LOBBY");
  buildWorld(mode);
  updateTileState(state.tiles);
  $("round-name").textContent = state.phase === "LOBBY"
    ? "SALA DE ESPERA"
    : state.phase === "PODIUM" ? "PODIO" : `${roundLabels[state.minigame] || "RONDA"} · ${state.round}/3`;
  $("timer").textContent = state.phase === "LOBBY" || state.phase === "PODIUM"
    ? "—"
    : state.phase === "COUNTDOWN" ? `${state.secondsLeft}` : `${state.secondsLeft}s`;

  const self = state.players.find((p) => p.id === selfId);
  if (self) {
    if (state.phase !== lastPhase || state.round !== lastRound ||
        Math.hypot(self.x - local.x, self.z - local.z) > 3) {
      local.x = self.x; local.z = self.z; local.y = self.y;
    }
  }
  lastPhase = state.phase;
  lastRound = state.round;

  for (const player of state.players) {
    let avatar = avatars.get(player.id);
    if (!avatar) {
      avatar = createAvatar(player);
      avatars.set(player.id, avatar);
    }
    avatar.target = { x: player.x, y: player.y, z: player.z, yaw: player.yaw };
    avatar.group.visible = !player.eliminated;
  }
  for (const [id, avatar] of avatars) {
    if (!state.players.some((player) => player.id === id)) {
      avatarLayer.remove(avatar.group);
      avatars.delete(id);
    }
  }

  renderScoreboard(state.players);
  const inLobby = state.phase === "LOBBY";
  lobbyCard.classList.toggle("hidden", !inLobby);
  $("room-label").textContent = state.room;
  $("lobby-title").textContent = state.players.length < 2 ? "Esperando jugadores…" : "¡Todos a la arena!";
  $("lobby-copy").textContent = `${state.players.length} jugador${state.players.length === 1 ? "" : "es"} en la sala. Comparte el código para invitar.`;
  startButton.classList.toggle("hidden", !inLobby || state.hostId !== selfId);
  $("podium-card").classList.toggle("hidden", state.phase !== "PODIUM");
  $("restart-button").classList.toggle("hidden", state.phase !== "PODIUM" || state.hostId !== selfId);
  if (state.phase === "PODIUM") {
    const winners = [...state.players].sort((a, b) => b.score - a.score).slice(0, 3);
    $("podium-list").innerHTML = winners.map((player, index) =>
      `<div class="podium-row"><span>${["🥇", "🥈", "🥉"][index]} ${escapeText(player.name)}</span><span>${player.score} puntos</span></div>`
    ).join("");
  }
  if (state.phase === "ROUND_OVER") {
    const winner = [...state.players].sort((a, b) => b.score - a.score)[0];
    showToast(winner ? `Ronda terminada · ${winner.name} va en cabeza` : "Ronda terminada");
  }
}

function connect(name, room) {
  const url = import.meta.env.DEV ? "http://localhost:3000" : location.origin;
  socket = io(url, { autoConnect: false, auth: { name, room }, reconnection: true });
  socket.on("connect", () => showToast("Conectado a la sala"));
  socket.on("connect_error", () => showToast("No se pudo conectar. Comprueba que el servidor esté activo."));
  socket.on("room:error", (message) => showToast(message.message || "No se pudo entrar a la sala."));
  socket.on("room:joined", (state) => {
    selfId = state.selfId;
    const self = state.players.find((player) => player.id === selfId);
    if (self) local = { x: self.x, y: self.y, z: self.z, yaw: self.yaw };
    joinCard.classList.add("hidden");
    updateUI(state);
  });
  socket.on("room:state", updateUI);
  socket.on("room:host-changed", ({ hostId }) => {
    if (roomState) updateUI({ ...roomState, hostId });
    showToast("El anfitrión de la sala ha cambiado.");
  });
  socket.on("room:player-joined", ({ player }) => showToast(`${player.name} se ha unido`));
  socket.on("room:player-left", () => showToast("Un jugador ha salido de la sala"));
  socket.connect();
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("name-input").value.trim();
  const room = $("room-input").value.trim() || "LOBBY";
  if (!name) return;
  $("room-label").textContent = room.toUpperCase();
  connect(name, room);
});

startButton.addEventListener("click", () => socket?.emit("room:start"));
$("restart-button").addEventListener("click", () => socket?.emit("room:restart"));
$("copy-room").addEventListener("click", async () => {
  const code = $("room-label").textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast(`Código ${code} copiado`);
  } catch {
    showToast(`Comparte este código: ${code}`);
  }
});
$("scores-toggle").addEventListener("click", () => $("scoreboard").classList.toggle("hidden"));

window.addEventListener("keydown", (event) => {
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
  if (event.code === "Tab") {
    event.preventDefault();
    $("scoreboard").classList.toggle("hidden");
  }
  if (event.code === "Space" && !lastJumpDown) jumpPressed = true;
  lastJumpDown = event.code === "Space" ? true : lastJumpDown;
  keys.add(event.code);
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
  if (event.code === "Space") lastJumpDown = false;
});
window.addEventListener("blur", () => keys.clear());
canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  pointerX = event.clientX;
  pointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  cameraYaw -= (event.clientX - pointerX) * 0.005;
  cameraPitch = Math.max(0.12, Math.min(0.8, cameraPitch + (event.clientY - pointerY) * 0.003));
  pointerX = event.clientX;
  pointerY = event.clientY;
});
canvas.addEventListener("pointerup", () => { dragging = false; });
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function hexIndexAt(x, z) {
  const col = Math.round(x / 1.75 + 2.5);
  const row = Math.round(z / 1.75 + 2.5);
  if (col < 0 || col > 5 || row < 0 || row > 5) return -1;
  const cx = (col - 2.5) * 1.75;
  const cz = (row - 2.5) * 1.75;
  return Math.abs(x - cx) <= 0.95 && Math.abs(z - cz) <= 0.95 ? row * 6 + col : -1;
}

function updateLocal(dt) {
  const active = roomState && ["LOBBY", "COUNTDOWN", "ACTIVE"].includes(roomState.phase);
  if (!active || (roomState.phase === "ACTIVE" && roomState.players.find((p) => p.id === selfId)?.eliminated)) return;
  let forward = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
  let side = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
  const magnitude = Math.hypot(forward, side) || 1;
  forward /= magnitude;
  side /= magnitude;
  const speed = 7.3;
  const dx = (Math.sin(cameraYaw) * forward + Math.cos(cameraYaw) * side) * speed * dt;
  const dz = (-Math.cos(cameraYaw) * forward + Math.sin(cameraYaw) * side) * speed * dt;
  local.x += dx;
  local.z += dz;
  local.yaw = Math.atan2(dx, -dz);

  const race = roomState.minigame === "race";
  const halfWidth = race ? 5.7 : roomState.minigame === "hex" ? 5.45 : 9;
  local.x = Math.max(-halfWidth, Math.min(halfWidth, local.x));
  if (race) local.z = Math.max(-29, Math.min(13, local.z));
  else if (roomState.minigame === "hex") local.z = Math.max(-5.45, Math.min(5.45, local.z));
  else local.z = Math.max(-9, Math.min(9, local.z));

  if (jumpPressed && local.y <= 0.02) jumpVelocity = 8.4;
  jumpPressed = false;
  jumpVelocity -= 21 * dt;
  local.y += jumpVelocity * dt;

  const hexIndex = roomState.minigame === "hex" ? hexIndexAt(local.x, local.z) : -1;
  const overTile = roomState.minigame === "hex" && hexIndex >= 0 && roomState.tiles[hexIndex] !== "gone";
  const onFloor = !roomState.minigame || roomState.minigame === "race" || overTile;
  if (onFloor && local.y <= 0) {
    local.y = 0;
    jumpVelocity = 0;
  }
  if (roomState.minigame === "race" && local.y < 0) {
    local.y = 0;
    jumpVelocity = 0;
  }
  if (roomState.minigame === "race" && local.y < 1.2) {
    for (const obstacle of movingObstacles) {
      if (obstacle.userData.kind === "roller" &&
          Math.abs(local.z - obstacle.position.z) < 0.9 && Math.abs(local.x) < 5.7) {
        local.z += Math.sign(local.z - obstacle.position.z || 1) * 0.17;
      } else if (obstacle.userData.kind === "block" &&
          Math.abs(local.z - obstacle.position.z) < 1.3 &&
          Math.abs(local.x - obstacle.position.x) < 1.35) {
        local.x += Math.sign(local.x - obstacle.position.x || 1) * 0.24;
      }
    }
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  updateLocal(dt);

  if (roomState && socket?.connected) {
    sendElapsed += dt;
    if (sendElapsed >= 1 / 20) {
      sendElapsed = 0;
      socket.emit("player:move", local);
    }
  }

  const time = now / 1000;
  for (const obstacle of movingObstacles) {
    if (obstacle.userData.kind === "roller") obstacle.rotation.x = time * 1.4;
    else obstacle.position.x = obstacle.userData.originX + Math.sin(time * 1.4 + obstacle.userData.phase) * 2;
  }
  for (const [id, avatar] of avatars) {
    const target = avatar.target;
    const amount = id === selfId ? 0.14 : 0.22;
    avatar.group.position.x += (target.x - avatar.group.position.x) * amount;
    avatar.group.position.y += (target.y - avatar.group.position.y) * amount;
    avatar.group.position.z += (target.z - avatar.group.position.z) * amount;
    avatar.group.rotation.y = target.yaw;
  }

  const followed = avatars.get(selfId)?.group;
  const focusX = followed ? followed.position.x : local.x;
  const focusY = followed ? followed.position.y + 0.8 : local.y + 0.8;
  const focusZ = followed ? followed.position.z : local.z;
  const distance = 10.5;
  const horizontal = Math.cos(cameraPitch) * distance;
  camera.position.set(
    focusX + Math.sin(cameraYaw) * horizontal,
    focusY + 2 + Math.sin(cameraPitch) * distance,
    focusZ + Math.cos(cameraYaw) * horizontal,
  );
  camera.lookAt(focusX, focusY, focusZ);
  renderer.render(scene, camera);
}

buildWorld("LOBBY");
requestAnimationFrame(animate);
