#!/usr/bin/env node
// Парсер новых проектов alot.pro: боты (TG/MAX/VK) и сайты.
//
//   node alot-parser.mjs                          # опрос примерно раз в минуту (±20%)
//   node alot-parser.mjs --once                   # один проход
//   node alot-parser.mjs --once --backfill=600    # + просканировать N id назад
//   node alot-parser.mjs --json                   # только JSONL в stdout
//   node alot-parser.mjs --keywords="бот,сайт,лендинг"   # свой список, поиск по заголовку и описанию
//   node alot-parser.mjs --categories=WEB,MOBILE,PROG_OTHER

import fs from 'node:fs';
import path from 'node:path';
import { createMatcher, buildRecord, findHead, scanNewProjects, sleep } from './alot-api.mjs';

const MAX_BATCHES = 20;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);

const INTERVAL = Number(args.interval ?? 60) * 1000;
const INTERVAL_LABEL =
  INTERVAL < 120_000 ? `${Math.round(INTERVAL / 1000)} с` : `${Math.round(INTERVAL / 60_000)} мин`;
const nextInterval = () => Math.round(INTERVAL * (0.8 + Math.random() * 0.4));
const BACKFILL = Number(args.backfill ?? 0);
const STATE_PATH = path.resolve(args.state ?? 'alot-state.json');
const OUT_PATH = path.resolve(args.out ?? 'new-projects.jsonl');

const matchProject = createMatcher({
  categories: args.categories ? String(args.categories).split(',').map((s) => s.trim()) : null,
  keywords: args.keywords ? String(args.keywords).split(',').map((s) => s.trim()).filter(Boolean) : null,
});

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { cursor: 0, seen: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

function report(project, hits) {
  const rec = buildRecord(project, hits);
  fs.appendFileSync(OUT_PATH, JSON.stringify(rec) + '\n');
  if (args.json) {
    console.log(JSON.stringify(rec));
    return;
  }
  const when = new Date(rec.publishedAt).toLocaleString('ru-RU');
  const desc = rec.description.replace(/\n+/g, ' ');
  console.log(`\n#${rec.id}  ${rec.title}`);
  console.log(`${rec.source} · ${rec.category} · ${rec.price || 'цена не указана'} · ${when}`);
  console.log(`Найдено по: ${hits.join(', ')}`);
  console.log(rec.url);
  console.log(desc.slice(0, 350) + (desc.length > 350 ? '…' : ''));
  console.log('─'.repeat(70));
}

async function runCycle(state) {
  if (!state.cursor) {
    const head = await findHead();
    state.cursor = Math.max(1, head - BACKFILL);
    state.head = head;
    console.log(`Максимальный id на сайте: ${head}, старт с ${state.cursor}`);
  }

  const from = state.cursor + 1;
  const seen = new Set(state.seen);
  let found = 0;

  const { cursor } = await scanNewProjects({
    cursor: state.cursor,
    head: state.head ?? 0,
    maxBatches: MAX_BATCHES,
    onProjects: async (items) => {
      for (const project of items) {
        if (seen.has(project.internalId)) continue;
        seen.add(project.internalId);
        const hits = matchProject(project);
        if (hits.length) {
          report(project, hits);
          found++;
        }
      }
    },
  });

  state.cursor = cursor;
  state.head = Math.max(state.head ?? 0, cursor);
  state.seen = [...seen].sort((a, b) => a - b).slice(-5000);
  saveState(state);
  return { found, from, to: cursor };
}

async function main() {
  const state = loadState();
  if (BACKFILL && !state.cursor) console.log(`Сканирую ${BACKFILL} последних id…`);
  if (!args.once) console.log(`Опрос примерно каждые ${INTERVAL_LABEL} (±20%). Ctrl+C — выход.`);

  if (args.once) {
    const { found } = await runCycle(state);
    console.log(`\nГотово. Новых подходящих проектов: ${found}`);
    return;
  }

  for (;;) {
    const startedAt = new Date().toLocaleTimeString('ru-RU');
    try {
      const { found, from, to } = await runCycle(state);
      const range = to >= from ? `id ${from}–${to}` : `id ${from}+ (новых пока нет)`;
      console.log(`[${startedAt}] ${range} · новых подходящих: ${found} · курсор ${state.cursor}`);
    } catch (err) {
      console.error(`[${startedAt}] Ошибка: ${err.message}`);
    }
    await sleep(nextInterval());
  }
}

main();
