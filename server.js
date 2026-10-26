const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "leaderboard.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const ALLOWED_EMOJIS = new Set([
  "😎", "😀", "😃", "😄", "😁", "😆", "🥳", "🤩",
  "😺", "🐱", "🐸", "🦊", "🐼", "🐵", "🐻", "🐰",
  "👾", "🤖", "👻", "💀", "⭐", "🔥", "🍀", "💎"
]);

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[<>]/g, "").trim().replace(/\s+/g, " ").slice(0, 20);
}

function readLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let leaderboard = readLeaderboard();

function saveLeaderboard() {
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(leaderboard, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function publicLeaderboard() {
  return leaderboard
    .slice()
    .sort((a, b) => (Number(b.bestScore) || 0) - (Number(a.bestScore) || 0))
    .slice(0, 100);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Serve frontend files from ./public. Put your game's index.html there.
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Frontend not found. Put your game HTML at public/index.html.");
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const clients = new Set();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcast(payload) {
  for (const client of clients) send(client, payload);
}
function sendLeaderboard() {
  broadcast({ type: "leaderboard", leaderboard: publicLeaderboard() });
}

wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, { type: "welcome", leaderboard: publicLeaderboard(), emojis: Array.from(ALLOWED_EMOJIS) });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", message: "Invalid JSON message." });
    }

    if (msg.type === "profile") {
      const name = cleanName(msg.name);
      const emoji = typeof msg.emoji === "string" && ALLOWED_EMOJIS.has(msg.emoji) ? msg.emoji : "😀";
      if (!name) return send(ws, { type: "error", message: "Choose a player name (1–20 characters)." });

      let player = leaderboard.find(p => p.key === name.toLowerCase());
      if (!player) {
        player = { key: name.toLowerCase(), name, emoji, bestScore: 0 };
        leaderboard.push(player);
      } else {
        player.name = name;
        player.emoji = emoji;
      }
      ws.playerKey = player.key;
      try { saveLeaderboard(); } catch (e) {
        console.error("Could not save leaderboard:", e.message);
        return send(ws, { type: "error", message: "Could not save leaderboard on this server." });
      }
      send(ws, { type: "profile", player, leaderboard: publicLeaderboard() });
      sendLeaderboard();
      return;
    }

    if (msg.type === "score") {
      const key = ws.playerKey;
      if (!key) return send(ws, { type: "error", message: "Choose your profile before submitting a score." });
      const score = Number(msg.score);
      if (!Number.isSafeInteger(score) || score < 0 || score > 1000000) {
        return send(ws, { type: "error", message: "Score must be a whole number from 0 to 1,000,000." });
      }
      const player = leaderboard.find(p => p.key === key);
      if (!player) return send(ws, { type: "error", message: "Profile not found. Select your profile again." });
      if (score > (Number(player.bestScore) || 0)) {
        player.bestScore = score;
        try { saveLeaderboard(); } catch (e) {
          console.error("Could not save score:", e.message);
          return send(ws, { type: "error", message: "Could not save score on this server." });
        }
      }
      send(ws, { type: "score", bestScore: player.bestScore, leaderboard: publicLeaderboard() });
      sendLeaderboard();
      return;
    }

    if (msg.type === "ping") send(ws, { type: "pong", at: Date.now() });
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mole Mash server listening on port ${PORT}`);
});
