// BotRoulette Server — OpenClaw Template
// Receives messages via HTTP, writes to inbox, polls outbox for bridge responses.
//
// IMPORTANT:
// - Handles both POST / and POST /api/chat (proxy sends to /)
// - Uses res.end(JSON.stringify(...)) not res.json() to avoid charset issues
// - All responses must be application/json — HTML is blocked by the tunnel

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

const INBOX_DIR = path.join(__dirname, 'inbox');
const OUTBOX_DIR = path.join(__dirname, 'outbox');
if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR);
if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR);

// Simple rate limiting
const hits = {};
function rateLimit(ip) {
  const now = Date.now();
  if (!hits[ip]) hits[ip] = [];
  hits[ip] = hits[ip].filter(t => now - t < 60000);
  if (hits[ip].length >= 30) return true;
  hits[ip].push(now);
  return false;
}

app.get('/health', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
});

async function handleChat(req, res) {
  if (rateLimit(req.ip)) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(429).end(JSON.stringify({ error: 'rate limited' }));
  }

  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).end(JSON.stringify({ error: 'missing or invalid message field' }));
  }
  if (message.length > 5000) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).end(JSON.stringify({ error: 'message too long' }));
  }

  const sessionId = req.body.session_id
    || req.headers['x-kpath-session-id'] || 'default';
  const id = Date.now().toString(36)
    + Math.random().toString(36).slice(2, 6);

  // Write to inbox for bridge to pick up
  fs.writeFileSync(path.join(INBOX_DIR, `${id}.json`), JSON.stringify({
    id, sessionId, message,
    timestamp: new Date().toISOString()
  }));

  // Poll outbox for bridge response (max 25s — tunnel has 30s limit)
  const outboxFile = path.join(OUTBOX_DIR, `${id}.json`);
  const deadline = Date.now() + 25000;

  while (Date.now() < deadline) {
    if (fs.existsSync(outboxFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
        fs.unlinkSync(outboxFile);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ response: data.reply }));
      } catch (e) { break; }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Timeout fallback — still valid JSON
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    response: 'still thinking on that one. try again in a moment.'
  }));
}

// Handle BOTH paths — the proxy sends to /
app.post('/api/chat', handleChat);
app.post('/', handleChat);

const PORT = process.env.PORT || 8900;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
