// Telegram-уведомления о новых заказах: long polling команд + отправка карточек.

import fs from 'node:fs';

const API = 'https://api.telegram.org';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatProject(project) {
  const desc = project.description || '';
  const short = desc.length > 400 ? `${desc.slice(0, 400)}…` : desc;
  const price = project.price || 'цена не указана';
  const meta = [project.source, project.category, price].filter(Boolean).map(escapeHtml).join(' · ');

  return [
    '<b>Новый заказ</b>',
    `<a href="${escapeHtml(project.url)}"><b>${escapeHtml(project.title)}</b></a>`,
    meta,
    short ? escapeHtml(short) : '',
    project.matchedKeywords?.length ? `Ключи: ${escapeHtml(project.matchedKeywords.join(', '))}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const keyboard = (project) => ({
  inline_keyboard: [[{ text: 'Открыть заказ', url: project.url }]],
});

export function createTelegram({ token, chatId = null, storePath = null, getLatest, getStats }) {
  const state = { token, chatId, offset: 0, running: false };

  function persist() {
    if (storePath) fs.writeFileSync(storePath, JSON.stringify({ chatId: state.chatId }));
  }

  async function call(method, payload, timeoutSec = 15) {
    const res = await fetch(`${API}/bot${state.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const error = new Error(json?.description || `HTTP ${res.status}`);
      error.code = res.status;
      throw error;
    }
    return json.result;
  }

  async function send(text, extra = {}) {
    if (!state.chatId) return false;
    try {
      await call('sendMessage', {
        chat_id: state.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
      return true;
    } catch (err) {
      console.error(`Telegram: не удалось отправить сообщение: ${err.message}`);
      return false;
    }
  }

  async function notifyProjects(projects) {
    const ordered = [...projects].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
    const limit = 10;

    for (const project of ordered.slice(0, limit)) {
      await send(formatProject(project), { reply_markup: keyboard(project) });
    }
    if (ordered.length > limit) {
      await send(`Ещё ${ordered.length - limit} новых заказов — смотрите на сайте.`);
    }
  }

  async function handleCommand(chat, text) {
    if (text.startsWith('/start')) {
      state.chatId = chat;
      persist();
      await send(
        'Готово, чат привязан.\n\nБуду присылать каждый новый заказ: боты (TG/MAX/VK) и сайты.\n\n/last — последние 5 заказов\n/stats — статистика\n/stop — отключить уведомления',
      );
      return;
    }

    if (state.chatId && chat !== state.chatId) return;

    if (text.startsWith('/stop')) {
      await send('Уведомления отключены. Вернуть: /start');
      state.chatId = null;
      persist();
      return;
    }

    if (text.startsWith('/last')) {
      const latest = getLatest?.(5) ?? [];
      if (!latest.length) {
        await send('Пока нет ни одного заказа.');
        return;
      }
      for (const project of latest) {
        await send(formatProject(project), { reply_markup: keyboard(project) });
      }
      return;
    }

    if (text.startsWith('/stats')) {
      const stats = getStats?.() ?? {};
      const updated = stats.updatedAt ? new Date(stats.updatedAt).toLocaleString('ru-RU') : '—';
      await send(
        `Всего заказов: ${stats.total ?? 0}\nПоследнее обновление: ${updated}\nКурсор id: ${stats.cursor ?? '—'}`,
      );
      return;
    }

    if (text.startsWith('/help')) {
      await send('/start — привязать чат\n/last — последние 5 заказов\n/stats — статистика\n/stop — отключить');
      return;
    }

    await send('Команды: /start, /last, /stats, /stop');
  }

  async function pollLoop() {
    while (state.running) {
      try {
        const updates = await call(
          'getUpdates',
          { offset: state.offset, timeout: 30, allowed_updates: ['message'] },
          40,
        );
        for (const update of updates ?? []) {
          state.offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text) continue;
          await handleCommand(message.chat.id, message.text.trim());
        }
      } catch (err) {
        if (err.code === 401 || err.code === 404) {
          console.error('Telegram: неверный токен бота, проверьте TELEGRAM_BOT_TOKEN');
          state.running = false;
          return;
        }
        console.error(`Telegram: ошибка получения обновлений: ${err.message}`);
        await sleep(5000);
      }
    }
  }

  return {
    get enabled() {
      return Boolean(state.token);
    },
    get chatId() {
      return state.chatId;
    },
    start() {
      if (!state.token) {
        console.log('Telegram: не настроен, добавьте TELEGRAM_BOT_TOKEN в .env');
        return;
      }
      state.running = true;
      pollLoop();
      console.log(
        state.chatId
          ? `Telegram: чат ${state.chatId} привязан`
          : 'Telegram: бот запущен, отправьте ему /start',
      );
    },
    send,
    notifyProjects,
  };
}
