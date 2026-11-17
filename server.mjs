#!/usr/bin/env node
// Локальный сервер: опрашивает alot.pro раз в минуту и отдаёт сайт со списком объявлений.
//
//   node server.mjs
//   PORT=3000 BACKFILL=3000 POLL_MS=60000 node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultMatcher,
  buildRecord,
  findHead,
  scanNewProjects,
  SITE_NAMES,
  REQUEST_DELAY_MIN,
  REQUEST_DELAY_MAX,
} from './alot-api.mjs';
import { createTelegram } from './telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // .env не обязателен
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const PORT = Number(process.env.PORT ?? 3000);
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
const POLL_JITTER = Math.min(0.9, Math.max(0, Number(process.env.POLL_JITTER ?? 0.2)));
const CLIENT_REFRESH_MS = 60_000;
const POLL_LABEL = POLL_MS < 120_000 ? `${Math.round(POLL_MS / 1000)} с` : `${Math.round(POLL_MS / 60_000)} мин`;
const BACKFILL = Number(process.env.BACKFILL ?? 3000);
const MAX_BATCHES = 40;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = loadStore();
const knownIds = new Set(db.projects.map((p) => p.id));
const startedAt = Date.now();
let polling = null;
let pollTimer = null;
let nextPollAt = null;

// пересчитываем читаемые названия источников после правок справочника
for (const project of db.projects) {
  if (project.sourceId && SITE_NAMES[project.sourceId]) project.source = SITE_NAMES[project.sourceId];
}

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { cursor: 0, head: 0, projects: [], updatedAt: null, lastError: null, parserEnabled: true, ...data };
  } catch {
    return { cursor: 0, head: 0, projects: [], updatedAt: null, lastError: null, parserEnabled: true };
  }
}

function saveStore() {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, STORE_PATH);
}

if (typeof db.parserEnabled !== 'boolean') db.parserEnabled = true;

const TELEGRAM_STATE = path.join(DATA_DIR, 'telegram.json');

function loadChatId() {
  try {
    return JSON.parse(fs.readFileSync(TELEGRAM_STATE, 'utf8')).chatId ?? null;
  } catch {
    return null;
  }
}

const telegram = createTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : loadChatId(),
  storePath: TELEGRAM_STATE,
  getLatest: (n) =>
    [...db.projects].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, n),
  getStats: () => ({ total: db.projects.length, updatedAt: db.updatedAt, cursor: db.cursor }),
});

function nextPollDelay() {
  const spread = POLL_MS * POLL_JITTER;
  return Math.round(POLL_MS - spread + Math.random() * spread * 2);
}

function schedulePoll(delay = nextPollDelay()) {
  clearTimeout(pollTimer);
  nextPollAt = Date.now() + delay;
  pollTimer = setTimeout(async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error(`Ошибка опроса: ${err.message}`);
    }
    schedulePoll();
  }, delay);
}

function setParserEnabled(enabled) {
  const wasEnabled = db.parserEnabled;
  db.parserEnabled = Boolean(enabled);
  saveStore();
  console.log(`Парсер ${db.parserEnabled ? 'включён' : 'на паузе'}`);

  if (db.parserEnabled && !wasEnabled) {
    schedulePoll(0);
  } else if (!db.parserEnabled) {
    clearTimeout(pollTimer);
    nextPollAt = null;
  }

  return db.parserEnabled;
}

async function pollOnce() {
  if (!db.parserEnabled) return { added: 0, paused: true };
  if (polling) return polling;

  polling = (async () => {
    let added = 0;
    const addedProjects = [];
    const bootstrapping = !db.cursor;
    try {
      if (!db.cursor) {
        const head = await findHead();
        db.cursor = Math.max(1, head - BACKFILL);
        db.head = head;
        console.log(`Максимальный id: ${head}, бэкфилл ${BACKFILL} id (с ${db.cursor})`);
      }

      const { cursor } = await scanNewProjects({
        cursor: db.cursor,
        head: db.head,
        maxBatches: MAX_BATCHES,
        onProjects: async (items) => {
          for (const project of items) {
            if (knownIds.has(project.internalId)) continue;
            knownIds.add(project.internalId);
            const hits = defaultMatcher(project);
            if (!hits.length) continue;
            const record = buildRecord(project, hits);
            db.projects.push(record);
            addedProjects.push(record);
            added++;
          }
        },
      });

      db.cursor = cursor;
      db.head = Math.max(db.head ?? 0, cursor);
      db.updatedAt = Date.now();
      db.lastError = null;
      saveStore();

      if (added) console.log(`[${new Date().toLocaleTimeString('ru-RU')}] новых объявлений: ${added}, всего: ${db.projects.length}`);

      if (addedProjects.length && !bootstrapping) {
        telegram.notifyProjects(addedProjects).catch((err) => console.error(`Telegram: ${err.message}`));
      }

      return { added };
    } catch (err) {
      db.lastError = err.message;
      saveStore();
      throw err;
    } finally {
      polling = null;
    }
  })();

  return polling;
}

function payload() {
  const projects = [...db.projects].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
  );
  return {
    projects,
    meta: {
      count: projects.length,
      updatedAt: db.updatedAt,
      cursor: db.cursor,
      polling: Boolean(polling),
      parserEnabled: db.parserEnabled,
      lastError: db.lastError,
      pollMs: POLL_MS,
      pollJitter: POLL_JITTER,
      nextPollAt: db.parserEnabled ? nextPollAt : null,
      clientRefreshMs: CLIENT_REFRESH_MS,
      telegram: { enabled: telegram.enabled, bound: Boolean(telegram.chatId) },
    },
  };
}

function statusPayload() {
  return {
    online: true,
    pid: process.pid,
    port: PORT,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    projects: db.projects.length,
    cursor: db.cursor,
    head: db.head,
    updatedAt: db.updatedAt,
    polling: Boolean(polling),
    parserEnabled: db.parserEnabled,
    pollMs: POLL_MS,
    pollJitter: POLL_JITTER,
    nextPollAt: db.parserEnabled ? nextPollAt : null,
    lastError: db.lastError,
    telegram: { enabled: telegram.enabled, bound: Boolean(telegram.chatId) },
  };
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const filePath = path.join(PUBLIC_DIR, decoded);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/projects' && req.method === 'GET') {
    sendJson(res, payload());
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, statusPayload());
    return;
  }

  if (url.pathname === '/api/parser' && (req.method === 'POST' || req.method === 'GET')) {
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (body === null) {
      sendJson(res, { error: 'Некорректный JSON' }, 400);
      return;
    }
    let next = body.enabled ?? url.searchParams.get('enabled');
    if (next === 'toggle') next = !db.parserEnabled;
    if (typeof next === 'string') next = next === 'on' || next === 'true' || next === '1';
    if (typeof next !== 'boolean') {
      sendJson(res, { error: 'Ожидается { "enabled": true|false }' }, 400);
      return;
    }
    setParserEnabled(next);
    sendJson(res, statusPayload());
    return;
  }

  if (url.pathname === '/api/refresh' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      await pollOnce();
    } catch (err) {
      console.error(`Ошибка опроса: ${err.message}`);
    }
    sendJson(res, payload());
    return;
  }

  if (req.method === 'GET') {
    sendStatic(res, url.pathname);
    return;
  }

  res.writeHead(405).end('Method not allowed');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Запустите с другим портом: PORT=3001 node server.mjs`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      saveStore();
    } catch {
      // выходим даже если не удалось сохранить
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

server.listen(PORT, () => {
  console.log(`Сайт: http://localhost:${PORT}`);
  console.log(
    `Опрос alot.pro примерно каждые ${POLL_LABEL} (±${Math.round(POLL_JITTER * 100)}%), паузы между запросами ${REQUEST_DELAY_MIN / 1000}–${REQUEST_DELAY_MAX / 1000} с`,
  );
  telegram.start();
});

pollOnce()
  .catch((err) => console.error(`Ошибка первичного опроса: ${err.message}`))
  .finally(() => schedulePoll());
