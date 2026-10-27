'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const WEB_DIR = [
  path.join(__dirname, 'www'),
  path.join(__dirname, '..', 'www')
].find(directory => fs.existsSync(path.join(directory, 'index.html'))) || path.join(__dirname, 'www');

const MATCH_DURATION_MS = 30_000;
const START_DELAY_MS = 4_000;
const MAX_SCORE = 100_000;
const MAX_NAME_LENGTH = 20;
const MAX_MESSAGE_BYTES = 4096;
const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 80;

// Explicit allow-list: clients cannot store arbitrary markup or unbounded emoji strings.
const ALLOWED_EMOJIS = new Set([
  '😎', '🐹', '🦊', '🤖', '🐸', '👾', '👽', '🐼', '🐯', '🐲', '🦄',
  '🥷', '👑', '💀', '🚀', '⭐', '🐵', '🐻', '🐰', '🐨', '🦁',
  '🐙', '🐢', '🐤', '🦋', '🔥', '⚡', '🌟', '🍀', '🎮', '🏆'
]);
const DEFAULT_EMOJI = '🐹';

const clients = new Set();
const queue = [];
let needsLeaderboardCleanup = false;
const leaderboard = loadLeaderboard();
let saveTimer = null;
if (needsLeaderboardCleanup) saveLeaderboardNow();

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_NAME_LENGTH);
}

function normalizeEmoji(value) {
  return typeof value === 'string' && ALLOWED_EMOJIS.has(value) ? value : null;
}

function loadLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : [];
    const map = new Map();

    for (const row of rows) {
      const score = row && (Number.isSafeInteger(row.bestScore) ? row.bestScore : row.score);
      if (!row || typeof row.name !== 'string' || !Number.isSafeInteger(score)) {
        needsLeaderboardCleanup = true;
        continue;
      }
      const name = normalizeName(row.name);
      if (!name || score < 0 || score > MAX_SCORE) {
        needsLeaderboardCleanup = true;
        continue;
      }
      const key = name.toLocaleLowerCase('en-US');
      const emoji = normalizeEmoji(row.emoji) || DEFAULT_EMOJI;
      const matchesPlayed = Number.isSafeInteger(row.matchesPlayed) && row.matchesPlayed >= 0 ? row.matchesPlayed : 0;
      const wins = Number.isSafeInteger(row.wins) && row.wins >= 0 ? row.wins : 0;
      const totalScore = Number.isSafeInteger(row.totalScore) && row.totalScore >= 0 ? row.totalScore : 0;
      const old = map.get(key);
      if (!old || score > old.bestScore) {
        map.set(key, {
          key,
          name,
          bestScore: score,
          emoji,
          matchesPlayed: Math.max(old ? old.matchesPlayed : 0, matchesPlayed),
          wins: Math.max(old ? old.wins : 0, wins),
          totalScore: Math.max(old ? old.totalScore : 0, totalScore)
        });
      } else if (old) {
        old.matchesPlayed = Math.max(old.matchesPlayed, matchesPlayed);
        old.wins = Math.max(old.wins, wins);
        old.totalScore = Math.max(old.totalScore, totalScore);
        if (!normalizeEmoji(old.emoji) && normalizeEmoji(row.emoji)) old.emoji = emoji;
      }
      if (old) needsLeaderboardCleanup = true;
    }
    return map;
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    console.error('Could not load leaderboard:', error.message);
    return new Map();
  }
}

function leaderboardRows() {
  return [...leaderboard.values()]
    .sort((a, b) => b.bestScore - a.bestScore || a.name.localeCompare(b.name))
    .map((row, index) => ({
      rank: index + 1,
      name: row.name,
      emoji: normalizeEmoji(row.emoji) || DEFAULT_EMOJI,
      bestScore: row.bestScore,
      matchesPlayed: row.matchesPlayed,
      wins: row.wins,
      totalScore: row.totalScore
    }));
}

function saveLeaderboardNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tempFile = `${LEADERBOARD_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify([...leaderboard.values()], null, 2), 'utf8');
    fs.renameSync(tempFile, LEADERBOARD_FILE);
  } catch (error) {
    console.error('Could not save online leaderboard:', error.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveLeaderboardNow();
  }, 250);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function send(client, payload) {
  if (!client || client.readyState !== WebSocket.OPEN) return;
  try { client.send(JSON.stringify(payload)); }
  catch (error) { console.error('WebSocket send error:', error.message); }
}

function broadcast(payload) {
  for (const client of clients) send(client, payload);
}

function broadcastPresence() {
  broadcast({ type: 'presence', playersOnline: clients.size, playersWaiting: queue.length });
}

function broadcastLeaderboard() {
  broadcast({ type: 'leaderboard', leaderboard: leaderboardRows() });
}

function persistProfile(client) {
  if (!client.name) return;
  const key = client.name.toLocaleLowerCase('en-US');
  const old = leaderboard.get(key);
  if (!old) return;
  const emoji = normalizeEmoji(client.emoji) || normalizeEmoji(old.emoji) || DEFAULT_EMOJI;
  if (old.emoji === emoji) return;
  old.emoji = emoji;
  scheduleSave();
  broadcastLeaderboard();
}

function updateLeaderboard(client, score) {
  if (!client.name || !Number.isSafeInteger(score) || score < 0 || score > MAX_SCORE) return false;

  const key = client.name.toLocaleLowerCase('en-US');
  const existing = leaderboard.get(key);
  const emoji = normalizeEmoji(client.emoji) || (existing && normalizeEmoji(existing.emoji)) || DEFAULT_EMOJI;

  leaderboard.set(key, {
    key,
    name: existing ? existing.name : client.name,
    bestScore: Math.max(existing ? existing.bestScore : 0, score),
    emoji,
    matchesPlayed: existing ? existing.matchesPlayed : 0,
    wins: existing ? existing.wins : 0,
    totalScore: existing ? existing.totalScore : 0
  });
  scheduleSave();
  return true;
}

function recordMatch(client, won) {
  if (!client.name || !Number.isSafeInteger(client.score) || client.score < 0 || client.score > MAX_SCORE) return;
  updateLeaderboard(client, client.score);
  const record = leaderboard.get(client.name.toLocaleLowerCase('en-US'));
  if (!record) return;
  record.matchesPlayed = Math.min(Number.MAX_SAFE_INTEGER, record.matchesPlayed + 1);
  record.wins = Math.min(Number.MAX_SAFE_INTEGER, record.wins + (won ? 1 : 0));
  record.totalScore = Math.min(Number.MAX_SAFE_INTEGER, record.totalScore + client.score);
  scheduleSave();
}

function removeFromQueue(client) {
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i] === client) { queue.splice(i, 1); changed = true; }
  }
  if (changed) broadcastPresence();
}

function finishMatch(match, disconnectedClient = null) {
  if (!match || match.ended) return;
  match.ended = true;
  if (match.deadline) clearTimeout(match.deadline);

  const [first, second] = match.players;

  let winnerId = null;
  if (disconnectedClient) winnerId = disconnectedClient === first ? second.id : first.id;
  else if (first.score !== second.score) winnerId = first.score > second.score ? first.id : second.id;
  recordMatch(first, first.id === winnerId);
  recordMatch(second, second.id === winnerId);

  const result = {
    type: 'match-result',
    matchId: match.id,
    players: match.players.map(player => ({
      id: player.id,
      name: player.name,
      emoji: normalizeEmoji(player.emoji) || DEFAULT_EMOJI,
      score: player.score,
      forfeited: player === disconnectedClient
    })),
    winnerId,
    draw: !disconnectedClient && first.score === second.score,
    leaderboard: leaderboardRows()
  };

  for (const player of match.players) {
    send(player, result);
    if (player.match === match) player.match = null;
    player.finished = true;
  }
  broadcastLeaderboard();
  broadcastPresence();
}

function pairPlayers(first, second) {
  const match = { id: randomUUID(), players: [first, second], ended: false, deadline: null };
  for (const player of match.players) {
    player.match = match;
    player.score = 0;
    player.finished = false;
  }

  const startAt = Date.now() + START_DELAY_MS;
  for (const player of match.players) {
    send(player, {
      type: 'match-found',
      matchId: match.id,
      selfId: player.id,
      startAt,
      duration: MATCH_DURATION_MS,
      players: match.players.map(opponent => ({
        id: opponent.id,
        name: opponent.name,
        emoji: normalizeEmoji(opponent.emoji) || DEFAULT_EMOJI,
        score: 0
      }))
    });
  }
  match.deadline = setTimeout(() => finishMatch(match), START_DELAY_MS + MATCH_DURATION_MS + 3000);
  broadcastPresence();
}

function joinQueue(client) {
  if (!client.name) return send(client, { type: 'error', message: 'Set a player name before matchmaking.' });
  if (client.match) return send(client, { type: 'error', message: 'You are already in a match.' });

  removeFromQueue(client);
  const index = queue.findIndex(player =>
    player !== client && player.readyState === WebSocket.OPEN && !player.match && player.name
  );

  if (index === -1) {
    queue.push(client);
    send(client, { type: 'queue', status: 'waiting', playersWaiting: queue.length });
    broadcastPresence();
    return;
  }
  const [opponent] = queue.splice(index, 1);
  pairPlayers(opponent, client);
}

function allowMessage(client) {
  const now = Date.now();
  if (now - client.rateWindowStart >= RATE_WINDOW_MS) {
    client.rateWindowStart = now;
    client.messageCount = 0;
  }
  client.messageCount += 1;
  return client.messageCount <= MAX_MESSAGES_PER_WINDOW;
}

function sendMatchScores(match) {
  const payload = {
    type: 'match-score',
    matchId: match.id,
    players: match.players.map(player => ({
      id: player.id,
      name: player.name,
      emoji: normalizeEmoji(player.emoji) || DEFAULT_EMOJI,
      score: player.score,
      finished: player.finished
    }))
  };
  for (const player of match.players) send(player, payload);
}

function handleMessage(client, raw) {
  if (!allowMessage(client)) {
    send(client, { type: 'error', message: 'Too many messages. Slow down and try again.' });
    return;
  }

  let message;
  try { message = JSON.parse(raw.toString()); }
  catch { return send(client, { type: 'error', message: 'Invalid message format.' }); }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'hello') {
    const name = normalizeName(message.name);
    if (!name) return send(client, { type: 'error', message: 'Enter a valid player name to connect.' });
    if (client.match || queue.includes(client)) {
      return send(client, { type: 'error', message: 'Leave matchmaking before changing your profile.' });
    }

    const requestedEmoji = normalizeEmoji(message.emoji);
    const key = name.toLocaleLowerCase('en-US');
    const existing = leaderboard.get(key);
    client.name = name;
    client.emoji = requestedEmoji || (existing && normalizeEmoji(existing.emoji)) || DEFAULT_EMOJI;

    // Existing records are migrated in place; scores are never reset by profile setup.
    persistProfile(client);
    send(client, {
      type: 'welcome',
      playerId: client.id,
      playersOnline: clients.size,
      emoji: client.emoji,
      leaderboard: leaderboardRows()
    });
    return;
  }

  if (message.type === 'set-profile') {
    if (!client.name) return send(client, { type: 'error', message: 'Send hello with a player name first.' });
    if (client.match || queue.includes(client)) {
      return send(client, { type: 'error', message: 'Leave matchmaking before changing your profile.' });
    }
    const name = message.name === undefined ? client.name : normalizeName(message.name);
    if (!name) return send(client, { type: 'error', message: 'Enter a valid player name.' });
    const emoji = message.emoji === undefined ? client.emoji : normalizeEmoji(message.emoji);
    if (!emoji) return send(client, { type: 'error', message: 'That profile emoji is not allowed.' });

    const oldKey = client.name.toLocaleLowerCase('en-US');
    const newKey = name.toLocaleLowerCase('en-US');
    const oldRecord = leaderboard.get(oldKey);
    const existingRecord = leaderboard.get(newKey);
    if (oldKey !== newKey) leaderboard.delete(oldKey);

    if (oldRecord || existingRecord) {
      const mergedRecords = oldRecord === existingRecord
        ? [oldRecord]
        : [oldRecord, existingRecord].filter(Boolean);
      const bestScore = Math.max(oldRecord ? oldRecord.bestScore : 0, existingRecord ? existingRecord.bestScore : 0);
      leaderboard.set(newKey, {
        key: newKey,
        name,
        bestScore,
        emoji,
        matchesPlayed: Math.min(Number.MAX_SAFE_INTEGER, mergedRecords.reduce((total, record) => total + record.matchesPlayed, 0)),
        wins: Math.min(Number.MAX_SAFE_INTEGER, mergedRecords.reduce((total, record) => total + record.wins, 0)),
        totalScore: Math.min(Number.MAX_SAFE_INTEGER, mergedRecords.reduce((total, record) => total + record.totalScore, 0))
      });
      scheduleSave();
      broadcastLeaderboard();
    }
    client.name = name;
    client.emoji = emoji;
    send(client, { type: 'profile-updated', name: client.name, emoji: client.emoji });
    return;
  }

  if (message.type === 'leaderboard') {
    send(client, { type: 'leaderboard', leaderboard: leaderboardRows() });
    return;
  }

  if (message.type === 'queue') return joinQueue(client);

  if (message.type === 'leave') {
    removeFromQueue(client);
    if (client.match) finishMatch(client.match, client);
    send(client, { type: 'left' });
    return;
  }

  if (message.type === 'score' || message.type === 'finish') {
    const match = client.match;
    if (!match || match.id !== message.matchId || match.ended || client.finished) return;
    const score = Number(message.score);
    if (!Number.isSafeInteger(score) || score < client.score || score < 0 || score > MAX_SCORE) {
      return send(client, { type: 'error', message: 'Invalid match score.' });
    }
    client.score = score;
    if (message.type === 'finish') client.finished = true;
    sendMatchScores(match);
    if (match.players.every(player => player.finished)) finishMatch(match);
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      status: 'ok',
      playersOnline: clients.size,
      playersWaiting: queue.length,
      activeMatches: [...clients].filter(client => client.match).length / 2
    }));
    return;
  }

  if (url.pathname === '/leaderboard') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    response.end(JSON.stringify(leaderboardRows().map(row => ({
      ...row,
      score: row.bestScore
    }))));
    return;
  }

  const webFile = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const contentTypes = {
    'index.html': 'text/html; charset=utf-8',
    'mole-mash-logo.png': 'image/png',
    'mole-mash-scene.svg': 'image/svg+xml',
    'meadow-mole.svg': 'image/svg+xml'
  };
  if (Object.prototype.hasOwnProperty.call(contentTypes, webFile)) {
    let content;
    try {
      content = fs.readFileSync(path.join(WEB_DIR, webFile));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        if (webFile === 'index.html') {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({
            service: 'Mole Mash online server',
            endpoints: { health: '/health', leaderboard: '/leaderboard', websocket: '/ws' }
          }));
        } else {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Not found' }));
        }
        return;
      }
      console.error(`Could not serve ${webFile}:`, error.message);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Game page or asset could not be loaded.');
      return;
    }

    response.writeHead(200, { 'content-type': contentTypes[webFile], 'cache-control': 'no-store' });
    response.end(content);
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

const webSockets = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

webSockets.on('connection', client => {
  client.id = randomUUID();
  client.name = '';
  client.emoji = DEFAULT_EMOJI;
  client.score = 0;
  client.finished = false;
  client.match = null;
  client.rateWindowStart = Date.now();
  client.messageCount = 0;
  clients.add(client);
  broadcastPresence();

  client.on('message', data => handleMessage(client, data));
  client.on('close', () => {
    clients.delete(client);
    removeFromQueue(client);
    if (client.match) finishMatch(client.match, client);
    broadcastPresence();
  });
  client.on('error', error => console.error('WebSocket connection error:', error.message));
});

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveLeaderboardNow();
  for (const client of clients) {
    try { client.close(1001, 'Server shutting down'); } catch {}
  }
  webSockets.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mole Mash Emoji Leaderboard listening on port ${PORT}`);
});
