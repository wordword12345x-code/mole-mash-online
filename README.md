# Mole Mash Online server

## Files
- `server.js` — HTTP server and WebSocket leaderboard/profile API.
- `package.json` — Node.js dependency and Render start command.
- `leaderboard.json` — initial leaderboard data.
- `public/index.html` — put your existing Mole Mash game HTML here.

## Local run
1. Install Node.js 18 or newer.
2. Run `npm install`
3. Run `npm start`
4. Open `http://localhost:3000`

## Render
Create a Web Service from this GitHub repository. Use:
- Build Command: `npm install`
- Start Command: `npm start`

WebSocket endpoint uses the same host as the website. In your browser game, connect with:
`const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);`

Send profile:
`ws.send(JSON.stringify({ type: "profile", name: "ok", emoji: "😎" }))`

Submit a score after choosing the profile:
`ws.send(JSON.stringify({ type: "score", score: 275 }))`

Messages from the server use JSON with `type` values such as `welcome`, `profile`, `leaderboard`, `score`, and `error`.

Important: Render's local filesystem may be temporary depending on the service/disk configuration. For guaranteed persistent scores after redeploys/restarts, use a persistent disk or a database. This starter saves to `leaderboard.json` when the filesystem is writable.
