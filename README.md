# Mole Mash Online

Mole Mash Online is a Node.js game server for real-time, two-player Mole Mash matches. It provides WebSocket matchmaking, live score updates, player profiles, match results, and a persistent leaderboard.

> **Repository status:** The current server implementation is present in `server.js`. The server looks for the browser game at `www/index.html` (and serves a small JSON service description if that page is missing). The checked-in `public/index.html` is empty, so this repository snapshot does not currently contain a usable game frontend at the location the server expects.

## How the project works

### 1. HTTP server

`server.js` creates a Node.js HTTP server and serves the game page and a small allow-list of static assets from the `www/` directory. It also exposes:

| Route | Purpose |
| --- | --- |
| `/` | Serves `www/index.html`; if it is missing, returns service information as JSON |
| `/health` | Reports server status, connected players, waiting players, and active matches |
| `/leaderboard` | Returns leaderboard data as JSON |
| `/ws` | WebSocket endpoint used by the game client |

### 2. WebSocket connection and profiles

The browser connects to the same host using WebSocket at `/ws`. After connecting, it sends a `hello` message containing a player name and optional emoji. The server validates and normalizes the name, restricts profile emojis to an allow-list, and responds with a `welcome` message containing the player ID and leaderboard.

Players can request the latest leaderboard, update their profile with `set-profile`, join matchmaking with `queue`, or leave with `leave`.

### 3. Matchmaking and gameplay

The server keeps connected clients in memory and pairs two eligible players from a waiting queue. Both players receive `match-found`, including a match ID, player details, a scheduled start time, and the match duration.

A match has a 4-second start delay and a 30-second play period. During play, clients send `score` updates (or a final `finish` message) with the match ID and score. The server checks that scores are valid and never decrease, then broadcasts the current scores to both players.

When both players finish, the timer expires, or a player disconnects/leaves, the server ends the match and sends a `match-result` message. A disconnected opponent forfeits; equal scores at a normal match end produce a draw.

### 4. Leaderboard storage

Leaderboard records are loaded from `DATA_DIR/leaderboard.json`. By default, `DATA_DIR` is `data` beside `server.js`. The server tracks each player's best score, matches played, wins, and total score. Writes are briefly batched and saved through a temporary file followed by a rename.

The root-level `leaderboard.json` currently in the repository is **not** the default data file used by the server. To use a different storage directory, set the `DATA_DIR` environment variable.

### 5. Basic safeguards

The server limits incoming WebSocket message size, applies a per-client message rate limit, validates names and emojis, and rejects invalid or decreasing match scores. These checks help protect the service, but they are not a substitute for stronger anti-cheat measures or production-grade identity and storage systems.

## Requirements

- Node.js (a current LTS release is recommended)
- npm
- The dependencies declared in `package.json` (including the `ws` WebSocket library)

## Run locally

From the repository root:

```bash
npm install
node server.js
```

The server listens on port `8080` by default. Set `PORT` to change it. Open `http://localhost:8080/health` to check the service.

The current `package.json` does not define an `npm start` script. Its `start:online` script points to `online-server/server.js`, which does not match the root-level `server.js` in this repository snapshot. Until the script is corrected, use `node server.js` to start the server.

## Deploying

For a Node.js hosting service, configure the project root as the repository root and use:

- **Build/install command:** `npm install`
- **Start command:** `node server.js`
- **Port:** use the hosting platform's `PORT` environment variable (the server reads it automatically)
- **Persistent data:** set `DATA_DIR` to a durable mounted directory if the platform's normal filesystem is ephemeral.

Ensure a real browser game page is placed at `www/index.html` and that any required assets are in `www/`; otherwise the root route will return the server's JSON fallback instead of the game.

## WebSocket message reference

All messages are JSON objects with a `type` field.

| Client message | Important fields | Description |
| --- | --- | --- |
| `hello` | `name`, optional `emoji` | Register the connection's player profile |
| `set-profile` | optional `name`, optional `emoji` | Change profile while not queued or in a match |
| `leaderboard` | — | Request the current leaderboard |
| `queue` | — | Join matchmaking |
| `leave` | — | Leave the queue or forfeit an active match |
| `score` | `matchId`, `score` | Send an updated match score |
| `finish` | `matchId`, `score` | Submit the final score and mark the player finished |

The server sends messages including `welcome`, `profile-updated`, `leaderboard`, `presence`, `queue`, `match-found`, `match-score`, `match-result`, `left`, and `error`.

Example browser connection:

```js
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${protocol}//${location.host}/ws`);

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    type: 'hello',
    name: 'Player One',
    emoji: '🐹'
  }));
});
```

A client should wait for `match-found` and use the returned `matchId` when sending `score` and `finish` messages.

## Operational notes

- Connected-player lists, matchmaking queues, and active matches live in memory. They are cleared when the server restarts.
- Leaderboard persistence depends on `DATA_DIR` being writable and durable. Use a persistent disk or external database for reliable production storage.
- The server currently trusts the game client to report its score subject to basic range and monotonicity checks. A modified client could still cheat; authoritative gameplay validation would be needed for competitive play.
