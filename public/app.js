const BOT_TERMS = new Set(['бот', 'чатбот', 'telegram', 'телеграм', 'тг', 'вконтакте', 'вк', 'vk', 'vkontakte', 'tg', 'max', 'макс']);
const SITE_TERMS = new Set(['сайт', 'лендинг', 'ландинг', 'landing', 'верстк', 'интернет-магазин', 'інтернет-магазин', 'web', 'веб', 'тильд', 'tilda', 'wordpress', 'битрикс', 'bitrix', 'cms', 'webflow', 'shopify']);

const $ = (id) => document.getElementById(id);
const list = $('list');

let all = [];
let known = new Set();
let byId = new Map();
let newMap = new Map();
let firstLoad = true;
let busy = false;
let fallbackMs = 60_000;
let nextSyncAt = Date.now() + fallbackMs;
let parserPaused = false;
let parserPolling = false;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const norm = (value) => String(value ?? '').toLowerCase().replace(/ё/g, 'е');

const safeUrl = (value) => (/^https:\/\/alot\.pro\//.test(String(value)) ? value : '#');

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'только что';
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

function typeOf(project) {
  const hits = (project.matchedKeywords || []).map(norm);
  if (hits.some((k) => BOT_TERMS.has(k))) return 'bot';
  if (hits.some((k) => SITE_TERMS.has(k))) return 'site';
  return 'other';
}

function isFresh(project) {
  const at = newMap.get(project.id);
  return Boolean(at) && Date.now() - at < 10 * 60 * 1000;
}

function filtered() {
  const q = norm($('q').value.trim());
  const type = $('type').value;
  const source = $('source').value;
  const min = $('min').value === '' ? null : Number($('min').value);
  const max = $('max').value === '' ? null : Number($('max').value);

  const items = all.filter((project) => {
    if (type !== 'all' && typeOf(project) !== type) return false;
    if (source !== 'all' && project.source !== source) return false;
    if (min !== null && (project.priceValue == null || project.priceValue < min)) return false;
    if (max !== null && (project.priceValue == null || project.priceValue > max)) return false;
    if (q && !norm(`${project.title} ${project.description}`).includes(q)) return false;
    return true;
  });

  const sort = $('sort').value;
  items.sort((a, b) => {
    if (sort === 'old') return new Date(a.publishedAt) - new Date(b.publishedAt);
    if (sort === 'price-desc') return (b.priceValue ?? -1) - (a.priceValue ?? -1);
    if (sort === 'price-asc') return (a.priceValue ?? 1e15) - (b.priceValue ?? 1e15);
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  return items;
}

function card(project) {
  const desc = project.description || 'Без описания';
  const long = desc.length > 320;
  const fresh = isFresh(project);

  return `
    <article class="card${fresh ? ' is-new' : ''}">
      <div class="card-head">
        <h2><a href="${esc(safeUrl(project.url))}" target="_blank" rel="noreferrer noopener">${esc(project.title)}</a></h2>
        ${project.price ? `<span class="price">${esc(project.price)}</span>` : ''}
      </div>
      <div class="meta">
        <span class="chip source">${esc(project.source || '—')}</span>
        ${project.category ? `<span class="chip">${esc(project.category)}</span>` : ''}
        <span>${esc(timeAgo(project.publishedAt))}</span>
        ${fresh ? '<span class="badge-new">новое</span>' : ''}
      </div>
      <p class="desc">${esc(long ? `${desc.slice(0, 320)}…` : desc)}</p>
      ${long ? `<button class="more" type="button" data-more="${project.id}">Показать полностью</button>` : ''}
      <div class="keywords">
        ${(project.matchedKeywords || []).map((k) => `<span class="kw">${esc(k)}</span>`).join('')}
      </div>
    </article>`;
}

function render() {
  for (const [id, at] of newMap) {
    if (Date.now() - at > 10 * 60 * 1000) newMap.delete(id);
  }

  const items = filtered();
  $('count').textContent = `Показано ${items.length} из ${all.length}`;
  list.innerHTML = items.map(card).join('');
  $('empty').hidden = items.length > 0;
}

function renderSources() {
  const select = $('source');
  const current = select.value;
  const sources = [...new Set(all.map((p) => p.source).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'));

  select.innerHTML =
    '<option value="all">Все источники</option>' +
    sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

  select.value = sources.includes(current) ? current : 'all';
}

function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')}` : `${seconds} с`;
}

function renderAuto() {
  if (busy) {
    $('auto').textContent = 'Обновление…';
    return;
  }
  if (parserPaused) {
    $('auto').textContent = 'Парсер на паузе';
    return;
  }
  if (parserPolling) {
    $('auto').textContent = 'Парсер опрашивает alot.pro…';
    return;
  }
  $('auto').textContent = `До обновления ${formatCountdown(secondsToSync())}`;
}

// страница обновляется сразу после того, как парсер закончит очередной опрос
function scheduleNextSync(meta) {
  const now = Date.now();
  if (meta.polling) {
    nextSyncAt = now + 2000;
  } else if (meta.parserEnabled && meta.nextPollAt) {
    nextSyncAt = Math.max(now + 3000, meta.nextPollAt + 3000);
  } else {
    // парсер на паузе: изредка проверяем, не включили ли его снова
    nextSyncAt = now + Math.min(fallbackMs, 15_000);
  }
}

function secondsToSync() {
  return Math.max(0, Math.ceil((nextSyncAt - Date.now()) / 1000));
}

function setBusy(value) {
  const button = $('refresh');
  button.disabled = value;
  button.textContent = value ? 'Обновляю…' : 'Обновить список';
  renderAuto();
}

function applyData(data) {
  const meta = data.meta || {};
  if (meta.clientRefreshMs) fallbackMs = meta.clientRefreshMs;
  parserPaused = meta.parserEnabled === false;
  parserPolling = Boolean(meta.polling);

  const incoming = data.projects || [];

  if (!firstLoad) {
    for (const project of incoming) {
      if (!known.has(project.id)) newMap.set(project.id, Date.now());
    }
  }
  firstLoad = false;

  all = incoming;
  known = new Set(all.map((p) => p.id));
  byId = new Map(all.map((p) => [p.id, p]));

  renderSources();
  render();

  $('updated').textContent = meta.updatedAt
    ? `Обновлено в ${new Date(meta.updatedAt).toLocaleTimeString('ru-RU')}`
    : 'Нет данных';

  $('err').hidden = !meta.lastError;
  if (meta.lastError) $('err').textContent = `Ошибка парсера: ${meta.lastError}`;

  const parserEl = $('parser');
  if (meta.parserEnabled === false) {
    parserEl.textContent = 'Парсер: на паузе';
    parserEl.className = 'tg wait';
  } else {
    parserEl.textContent = 'Парсер: включён';
    parserEl.className = 'tg on';
  }

  const tg = meta.telegram || {};
  const tgEl = $('tg');
  if (!tg.enabled) {
    tgEl.textContent = 'Telegram: не настроен';
    tgEl.className = 'tg off';
  } else if (tg.bound) {
    tgEl.textContent = 'Telegram: уведомления включены';
    tgEl.className = 'tg on';
  } else {
    tgEl.textContent = 'Telegram: отправьте боту /start';
    tgEl.className = 'tg wait';
  }

  scheduleNextSync(meta);
}

async function load(refresh = false) {
  if (busy) return;
  busy = true;
  setBusy(true);

  try {
    const res = await fetch(refresh ? '/api/refresh' : '/api/projects', {
      method: refresh ? 'POST' : 'GET',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyData(await res.json());
  } catch (err) {
    $('err').hidden = false;
    $('err').textContent = `Не удалось обновить: ${err.message}`;
    nextSyncAt = Date.now() + fallbackMs;
  } finally {
    busy = false;
    setBusy(false);
  }
}

list.addEventListener('click', (event) => {
  const button = event.target.closest('button.more');
  if (!button) return;
  const project = byId.get(Number(button.dataset.more));
  if (!project) return;
  button.closest('.card').querySelector('.desc').textContent = project.description || 'Без описания';
  button.remove();
});

for (const id of ['q', 'min', 'max']) {
  $(id).addEventListener('input', render);
}
for (const id of ['type', 'source', 'sort']) {
  $(id).addEventListener('change', render);
}

$('refresh').addEventListener('click', () => load(true));

$('reset').addEventListener('click', () => {
  $('q').value = '';
  $('min').value = '';
  $('max').value = '';
  $('type').value = 'all';
  $('source').value = 'all';
  $('sort').value = 'new';
  render();
});

setInterval(() => {
  if (!busy && Date.now() >= nextSyncAt) load();
  renderAuto();
}, 1000);

load();
