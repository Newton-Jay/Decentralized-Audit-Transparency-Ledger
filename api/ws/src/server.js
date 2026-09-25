const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { createClient } = require('redis');

const app = express();
app.use(bodyParser.json());

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const subs = new Map();
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
const EVENT_BUS_CHANNEL = process.env.EVENT_BUS_CHANNEL || 'audit-ledger:events';
const REDIS_URL = process.env.REDIS_URL;
const publisher = REDIS_URL ? createClient({ url: REDIS_URL }) : null;
const subscriber = publisher ? publisher.duplicate() : null;

function createFilterState() {
  return { filters: new Map(), acknowledged: new Set() };
}

function matchesFilter(filter, evt) {
  if (filter.types.size > 0 && !filter.types.has(evt.event_type)) return false;
  if (filter.submitters.size > 0 && !filter.submitters.has(evt.submitter)) return false;
  if (filter.startTime !== null && evt.timestamp < filter.startTime) return false;
  if (filter.endTime !== null && evt.timestamp > filter.endTime) return false;
  return true;
}

function rejectUpgrade(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function verifyJwt(token) {
  if (!token || !JWT_PUBLIC_KEY || !JWT_ISSUER || !JWT_AUDIENCE) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const validSignature = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      JWT_PUBLIC_KEY,
      Buffer.from(parts[2], 'base64url'),
    );
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];

    if (header.alg !== 'RS256' || !validSignature) return null;
    if (payload.iss !== JWT_ISSUER || !audiences.includes(JWT_AUDIENCE)) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now) return null;
    if (!scopes.includes('events:read')) return null;
    return payload;
  } catch {
    return null;
  }
}

function bearerToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

function applyFilter(filter, data) {
  if (data.type) filter.types.add(data.type);
  if (data.submitter) filter.submitters.add(data.submitter);
  if (data.startTime != null) filter.startTime = data.startTime;
  if (data.endTime != null) filter.endTime = data.endTime;
  if (data.filters) {
    if (Array.isArray(data.filters.types)) data.filters.types.forEach((type) => filter.types.add(type));
    if (Array.isArray(data.filters.submitters)) data.filters.submitters.forEach((submitter) => filter.submitters.add(submitter));
    if (data.filters.startTime != null) filter.startTime = data.filters.startTime;
    if (data.filters.endTime != null) filter.endTime = data.filters.endTime;
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  const state = createFilterState();
  subs.set(ws, state);
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      sendJson(ws, { type: 'error', code: 'INVALID_JSON' });
      return;
    }

    const subscriptionId = String(data.subscription_id ?? data.subscriptionId ?? 'default');
    if (data.action === 'subscribe' || data.action === 'subscribe_all') {
      if (!state.filters.has(subscriptionId) && state.filters.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
        sendJson(ws, { type: 'error', code: 'SUBSCRIPTION_LIMIT', subscription_id: subscriptionId });
        return;
      }
      const filter = state.filters.get(subscriptionId) || { types: new Set(), submitters: new Set(), startTime: null, endTime: null };
      if (data.action === 'subscribe_all') {
        filter.types.clear();
        filter.submitters.clear();
        filter.startTime = null;
        filter.endTime = null;
      } else {
        applyFilter(filter, data);
      }
      state.filters.set(subscriptionId, filter);
      sendJson(ws, { type: 'ack', action: 'subscribed', subscription_id: subscriptionId });
      return;
    }

    if (data.action === 'unsubscribe') {
      state.filters.delete(subscriptionId);
      sendJson(ws, { type: 'ack', action: 'unsubscribed', subscription_id: subscriptionId });
      return;
    }

    if (data.action === 'ack') {
      const messageId = String(data.message_id ?? data.messageId ?? '');
      if (messageId) state.acknowledged.add(messageId);
      sendJson(ws, { type: 'ack', action: 'acknowledged', message_id: messageId });
      return;
    }

    sendJson(ws, { type: 'error', code: 'UNKNOWN_ACTION' });
  });

  ws.on('close', () => subs.delete(ws));
});

server.on('upgrade', (request, socket, head) => {
  const payload = verifyJwt(bearerToken(request));
  if (!payload) {
    rejectUpgrade(socket);
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.auth = payload;
    wss.emit('connection', ws, request);
  });
});

function broadcastEvent(evt) {
  for (const [ws, state] of subs.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    for (const [subscriptionId, filter] of state.filters.entries()) {
      if (matchesFilter(filter, evt)) {
        sendJson(ws, {
          type: 'event_logged',
          event: evt,
          subscription_id: subscriptionId,
          message_id: String(evt.index),
        });
      }
    }
  }
}

function publishEvent(evt) {
  if (publisher && publisher.isOpen) {
    void publisher.publish(EVENT_BUS_CHANNEL, JSON.stringify(evt));
    return;
  }
  broadcastEvent(evt);
}

if (publisher && subscriber) {
  publisher.on('error', () => {});
  subscriber.on('error', () => {});
  void Promise.all([publisher.connect(), subscriber.connect()])
    .then(() => subscriber.subscribe(EVENT_BUS_CHANNEL, (message) => {
      try {
        broadcastEvent(JSON.parse(message));
      } catch {
        return;
      }
    }))
    .catch(() => {});
}

// Simple HTTP emit endpoint for testing: POST /emit { event }
app.post('/emit', (req, res) => {
  const expectedKey = process.env.EMIT_KEY;
  if (!expectedKey || req.get('x-emit-key') !== expectedKey) return res.status(401).send('unauthorized');
  const evt = req.body.event;
  if (!evt) return res.status(400).send('no event');
  publishEvent(evt);
  res.send('ok');
});

// Health check endpoints (#268)
const wsStartTime = Date.now();

app.get('/healthz', (req, res) => res.json({
  status: 'ok',
  service: 'websocket',
  uptime: Math.floor((Date.now() - wsStartTime) / 1000),
  connections: subs.size,
  timestamp: new Date().toISOString(),
}));

app.get('/readyz', (req, res) => {
  const checks = {
    websocket: { status: wss.readyState === 0 ? 'ok' : 'degraded' },
  };
  const allHealthy = Object.values(checks).every((c) => c.status === 'ok');
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    service: 'websocket',
    checks,
    connections: subs.size,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Periodic ping for connection health
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log('ws server listening', PORT));
