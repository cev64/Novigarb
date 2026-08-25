// Local web server: serves the dashboard and streams scan results over SSE.
//
//   node server.js        ->  http://localhost:8787

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './src/engine.js';
import { config } from './src/config.js';
import { log, warn } from './src/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// The odds board can run to several thousand rows; cap what goes over the wire and
// send the most interesting rows first.
const BOARD_LIMIT = Number(process.env.BOARD_LIMIT || 500);
const OPPORTUNITY_LIMIT = Number(process.env.OPPORTUNITY_LIMIT || 200);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const engine = new Engine();
const clients = new Set();

function wireFormat(snapshot) {
  const board = [...snapshot.board]
    .sort((a, b) => (b.bestEdge ?? -1) - (a.bestEdge ?? -1))
    .slice(0, BOARD_LIMIT);

  return {
    ...snapshot,
    opportunities: snapshot.opportunities.slice(0, OPPORTUNITY_LIMIT),
    board,
    boardTotal: snapshot.board.length,
  };
}

engine.on('update', (snapshot) => {
  const payload = `data: ${JSON.stringify(wireFormat(snapshot))}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
});

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);

  // Never serve outside public/.
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(wireFormat(engine.snapshot))}\n\n`);
    clients.add(res);

    // Comment frames keep intermediaries from closing an idle stream.
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cleaned up on close */
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(wireFormat(engine.snapshot)));
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    try {
      const patch = JSON.parse((await readBody(req)) || '{}');
      engine.updateSettings(patch);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, settings: engine.settings }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    warn(`Port ${config.port} is already in use — Novigarb may already be running.`);
    warn(`Open http://localhost:${config.port}, or start this one on another port with PORT=8788 node server.js`);
  } else {
    warn(`Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(config.port, () => {
  log(`Novigarb listening on http://localhost:${config.port}`);
  log(`scanning every ${config.pollMs}ms · anchor leg sized to $${config.targetStake}`);
  engine.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    engine.stop();
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

process.on('unhandledRejection', (err) => warn('unhandled rejection:', err?.message || err));
