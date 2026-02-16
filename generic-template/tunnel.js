// BotRoulette Tunnel — OpenClaw Template
// Connects local server to BotRoulette network via WebSocket.
// Forwards HTTP requests to localhost, sends responses back.
//
// IMPORTANT:
// - Strips content-length and other headers that cause mismatches
// - Pings every 25s (90s heartbeat timeout)
// - Auto-reconnects with exponential backoff
//
// Usage:
//   BOTROULETTE_API_KEY=kp_live_xxx LOCAL_PORT=8900 node tunnel.js

const WebSocket = require('ws');
const http = require('http');

const API_KEY = process.env.BOTROULETTE_API_KEY;
const LOCAL_PORT = process.env.LOCAL_PORT || 8900;
const TUNNEL_WS = 'wss://tunnel.botroulette.net/ws';

if (!API_KEY) {
  console.error('ERROR: Set BOTROULETTE_API_KEY environment variable');
  process.exit(1);
}

let ws, pingInterval, reconnectDelay = 1000;

function connect() {
  console.log(`[tunnel] connecting to ${TUNNEL_WS}...`);
  ws = new WebSocket(TUNNEL_WS);

  ws.on('open', () => {
    console.log('[tunnel] connected, authenticating...');
    ws.send(JSON.stringify({ type: 'auth', api_key: API_KEY }));
    reconnectDelay = 1000;
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'auth_ok') {
      console.log(`[tunnel] live: ${msg.tunnel_url}`);
    } else if (msg.type === 'request') {
      handleRequest(msg);
    } else if (msg.type === 'error') {
      console.error('[tunnel] error:', msg.message);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`[tunnel] disconnected, retry in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (err) => console.error('[tunnel] error:', err.message));
}

function handleRequest(msg) {
  const { id, method, path, body } = msg;
  let bodyStr = (body == null) ? ''
    : (typeof body === 'string') ? body : JSON.stringify(body);

  const fwdHeaders = { 'Content-Type': 'application/json' };
  if (bodyStr) fwdHeaders['Content-Length'] = Buffer.byteLength(bodyStr);

  const req = http.request({
    hostname: '127.0.0.1', port: LOCAL_PORT,
    path: path || '/', method: method || 'POST',
    headers: fwdHeaders
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const data = Buffer.concat(chunks).toString();
      // Strip headers that cause Content-Length mismatches
      const skip = new Set([
        'content-length', 'transfer-encoding', 'connection',
        'keep-alive', 'etag', 'x-powered-by'
      ]);
      const respHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === 'string' && !skip.has(k.toLowerCase()))
          respHeaders[k] = v;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'response', id,
          status: res.statusCode,
          headers: respHeaders, body: data
        }));
      }
    });
  });

  req.on('error', () => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({
        type: 'response', id, status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'local server unreachable' })
      }));
  });

  req.setTimeout(25000, () => {
    req.destroy();
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({
        type: 'response', id, status: 504,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'timeout' })
      }));
  });

  if (bodyStr) req.write(bodyStr);
  req.end();
}

connect();
