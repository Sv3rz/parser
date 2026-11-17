#!/usr/bin/env node
// Панель управления: сайт (запуск/остановка) и парсер (пауза/возобновление).
//
//   panel.bat                 — интерактивное меню
//   node ctl.mjs status [--json]
//   node ctl.mjs site start|stop|restart|open
//   node ctl.mjs parser on|off|toggle
//   node ctl.mjs logs [site]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env не обязателен
}

const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const PID_FILE = path.join(DATA_DIR, 'site.pid');
const LOG_FILE = path.join(LOG_DIR, 'site.log');
const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function panelPid() {
  const pid = readPid();
  if (!pid) return null;
  if (alive(pid)) return pid;
  fs.rmSync(PID_FILE, { force: true });
  return null;
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function serverStatus() {
  try {
    return await api('/api/status');
  } catch {
    return null;
  }
}

async function waitForSite(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await serverStatus();
    if (status) return status;
    await sleep(300);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  return !alive(pid);
}

async function startSite() {
  const pid = panelPid();
  if (pid) return { ok: true, message: `Сайт уже запущен (PID ${pid}) — ${BASE}` };

  const external = await serverStatus();
  if (external) {
    fs.writeFileSync(PID_FILE, String(external.pid));
    return { ok: true, message: `Сайт уже работает (PID ${external.pid}) — ${BASE}` };
  }

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(PID_FILE, String(child.pid));

  const status = await waitForSite();
  if (!status) {
    return {
      ok: false,
      message: `Сайт не ответил за 12 с. Проверьте ${path.relative(ROOT, LOG_FILE)} или занятый порт ${PORT}.`,
    };
  }

  return { ok: true, message: `Сайт запущен (PID ${status.pid}) — ${BASE}` };
}

async function stopSite() {
  const status = await serverStatus();
  const pid = panelPid() ?? status?.pid ?? null;
  if (!pid) return { ok: true, message: 'Сайт уже остановлен' };

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // уже остановлен
    }
  }

  const stopped = await waitForExit(pid);
  if (!stopped) {
    return { ok: false, message: `Не удалось остановить процесс PID ${pid}` };
  }

  fs.rmSync(PID_FILE, { force: true });
  return { ok: true, message: `Сайт остановлен (PID ${pid})` };
}

async function setParser(enabled) {
  const status = await serverStatus();
  if (!status) {
    return { ok: false, message: 'Сайт не запущен — парсер работает внутри сайта. Сначала запустите сайт.' };
  }
  try {
    const result = await api('/api/parser', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    return {
      ok: true,
      message: result.parserEnabled ? 'Парсер включён' : 'Парсер на паузе — alot.pro не опрашивается',
    };
  } catch (err) {
    return { ok: false, message: `Не удалось переключить парсер: ${err.message}` };
  }
}

function openSite() {
  const args = process.platform === 'win32' ? ['/c', 'start', '', BASE] : [BASE];
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { ok: true, message: `Открываю ${BASE}` };
}

function tailLog(lines = 20) {
  try {
    const all = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split(/\r?\n/);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

function formatUptime(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

function formatTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function collect() {
  const pid = panelPid();
  const status = await serverStatus();
  return {
    pid: status?.pid ?? pid,
    ownPid: pid,
    status,
    running: Boolean(status),
  };
}

function renderStatus(state) {
  const { status } = state;
  const lines = ['', '  alot.pro — панель управления', '  ' + '─'.repeat(46)];

  if (!status) {
    lines.push('  Сайт     : выключен');
    lines.push('  Парсер   : недоступен (сайт не запущен)');
  } else {
    lines.push(`  Сайт     : включён — ${BASE}  (PID ${status.pid})`);
    lines.push(`  Адрес    : ${BASE}`);
    lines.push(`  Аптайм   : ${formatUptime(status.uptime)}`);
    lines.push(`  Парсер   : ${status.parserEnabled ? 'включён' : 'на паузе'}${status.polling ? ', опрашивает…' : ''}`);
    lines.push(`  Объявл.  : ${status.projects}   курсор ${status.cursor ?? '—'}`);
    const pollMs = status.pollMs ?? 60_000;
    const interval = pollMs < 120_000 ? `${Math.round(pollMs / 1000)} с` : `~${Math.round((pollMs / 60_000) * 10) / 10} мин`;
    const jitter = Math.round((status.pollJitter ?? 0) * 100);
    lines.push(`  Интервал : ${interval} ±${jitter}%   последний опрос ${formatTime(status.updatedAt)}`);
    lines.push(`  Следующий: ${status.parserEnabled ? formatTime(status.nextPollAt) : '— (парсер на паузе)'}`);
  }

  if (status) {
    lines.push(`  Telegram : ${status.telegram.enabled ? (status.telegram.bound ? 'включён, чат привязан' : 'включён, чат не привязан (/start)') : 'выключен (нет токена в .env)'}`);
    if (status.lastError) lines.push(`  Ошибка   : ${status.lastError}`);
  }

  if (status && !state.ownPid) {
    lines.push('  Внимание : сайт запущен вне панели — кнопка «Остановить» всё равно работает');
  }

  lines.push('  ' + '─'.repeat(46));
  console.log(lines.join('\n'));
}

function printMenu() {
  console.log(
    [
      '  1  Открыть сайт в браузере',
      '  2  Запустить / остановить сайт',
      '  3  Перезапустить сайт',
      '  4  Пауза / возобновить парсер',
      '  5  Последние строки лога',
      '  6  Обновить статус',
      '  0  Выход',
      '',
    ].join('\n'),
  );
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) =>
    new Promise((resolve) => {
      if (rl.closed) resolve(null);
      else rl.question(question, resolve);
    });
  const pause = async () => {
    await ask('\n  Enter — назад в меню ');
  };

  try {
    for (;;) {
      console.clear();
      const state = await collect();
      renderStatus(state);
      printMenu();

      const answer = await ask('  Выбор: ');
      if (answer == null) break;
      const choice = answer.trim();

      if (choice === '0' || choice.toLowerCase() === 'q') break;

      if (choice === '1') {
        console.log(`\n  ${openSite().message}`);
        await pause();
      } else if (choice === '2') {
        const result = state.running ? await stopSite() : await startSite();
        console.log(`\n  ${result.message}`);
        await pause();
      } else if (choice === '3') {
        const stopped = await stopSite();
        console.log(`\n  ${stopped.message}`);
        if (stopped.ok) {
          const started = await startSite();
          console.log(`  ${started.message}`);
        }
        await pause();
      } else if (choice === '4') {
        if (!state.status) {
          console.log('\n  Сайт не запущен — парсер работает внутри сайта. Сначала запустите сайт.');
        } else {
          const result = await setParser(!state.status.parserEnabled);
          console.log(`\n  ${result.message}`);
        }
        await pause();
      } else if (choice === '5') {
        const lines = tailLog(20);
        console.log(`\n  ${path.relative(ROOT, LOG_FILE)}\n`);
        if (lines.length) console.log(lines.map((line) => `  ${line}`).join('\n'));
        else console.log('  Лог пока пуст');
        console.log('');
        await pause();
      } else if (choice === '6') {
        continue;
      }
    }
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(
    [
      'Панель управления alot.pro',
      '',
      '  panel.bat                    — интерактивное меню',
      '  node ctl.mjs status [--json]',
      '  node ctl.mjs site start|stop|restart|open',
      '  node ctl.mjs parser on|off|toggle',
      '  node ctl.mjs logs [site]',
      '  node ctl.mjs open',
    ].join('\n'),
  );
}

async function main() {
  const [, , command = 'menu', sub = ''] = process.argv;

  if (command === 'status') {
    const state = await collect();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ sitePid: state.ownPid, running: state.running, status: state.status }, null, 2));
      return;
    }
    renderStatus(state);
    return;
  }

  if (command === 'site') {
    if (sub === 'start') console.log((await startSite()).message);
    else if (sub === 'stop') console.log((await stopSite()).message);
    else if (sub === 'restart') {
      console.log((await stopSite()).message);
      console.log((await startSite()).message);
    } else if (sub === 'open') console.log(openSite().message);
    else console.log('Использование: node ctl.mjs site start|stop|restart|open');
    return;
  }

  if (command === 'parser') {
    const status = await serverStatus();
    const next =
      sub === 'on' ? true : sub === 'off' ? false : sub === 'toggle' || !sub ? !(status?.parserEnabled ?? true) : null;
    if (next === null) {
      console.log('Использование: node ctl.mjs parser on|off|toggle');
      return;
    }
    const result = await setParser(next);
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'open') {
    console.log(openSite().message);
    return;
  }

  if (command === 'logs') {
    const lines = tailLog(40);
    if (!lines.length) {
      console.log(`Лог пока пуст: ${path.relative(ROOT, LOG_FILE)}`);
      return;
    }
    console.log(lines.join('\n'));
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'menu') {
    await menu();
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
});
