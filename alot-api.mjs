// Общая логика работы с API alot.pro: запросы, поиск головы ленты, фильтр объявлений.

export const API = 'https://alot.pro/api/v2/';
export const BATCH = 100;

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: 'https://alot.pro',
  Referer: 'https://alot.pro/projects/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
};

// тема проекта в заголовке
const BOT_TERMS = ['бот', 'чатбот', 'telegram', 'телеграм', 'тг', 'вконтакте', 'вк', 'vk', 'vkontakte', 'tg', 'max', 'макс'];
const SITE_TERMS = ['сайт', 'лендинг', 'ландинг', 'landing', 'верстк', 'интернет-магазин', 'інтернет-магазин', 'web', 'веб', 'тильд', 'tilda', 'wordpress', 'битрикс', 'bitrix', 'cms', 'webflow', 'shopify'];
// чем с проектом надо что-то сделать (нужно, если категория не «программирование»)
const ACTION_TERMS = ['созда', 'сдела', 'разработ', 'доработ', 'правк', 'исправ', 'внести', 'вносить', 'настро', 'сверста', 'додела', 'передела', 'перенес', 'перенос', 'обновит', 'обновлен', 'под ключ', 'написа', 'реализ', 'добав', 'интегрир', 'подключ'];

export const NEGATIVE_TERMS = ['отзыв', 'парсинг', 'сбор данных', 'сбор открытых', 'продвижен', 'seo', 'реклам', 'закупк', 'бухгалтер', 'юрист', 'водител', 'call-центр', 'менеджер по продаж'];

export const PROG_CATEGORIES = ['WEB', 'MOBILE', 'PROG_OTHER', 'PROG_1C', 'PROG_GAMES'];

export const BOT_KEYWORDS = new Set(BOT_TERMS);
export const SITE_KEYWORDS = new Set(SITE_TERMS);

export const SITE_NAMES = {
  flru: 'FL.ru', youdoru: 'YouDo.ru', freelanceru: 'Freelance.ru',
  lclancerru: '1CLancer.ru', kworkru: 'KWork.ru', vkcom: 'Паблики VK',
  hhru: 'hh.ru', trudvsemru: 'Работа России', habrcareer: 'Хабр Карьера',
  superjobru: 'Superjob.ru', rabotaru: 'Rabota.ru', geekjobru: 'GeekJob',
  getmatchru: 'GetMatch', hirehiru: 'HireHi', joblabru: 'JobLab',
  remotejobru: 'Remote-job', kadrofru: 'Kadrof.ru', etxtru: 'eTXT.ru',
  advegocom: 'Advego', turbotextru: 'Turbotext', workzillaru: 'Work-zilla',
  workspaceru: 'Workspace', miratextru: 'Miratext', taskpayru: 'TaskPay',
  contentmonsterru: 'ContentMonster', careeristru: 'Careerist',
  freelancersnet: 'Free-lancers.net', freelancejobru: 'FreelanceJob',
  fretenru: 'Freten', freelancerbaycom: 'FreelancerBay',
  freelancehuntcom: 'Freelancehunt',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// человекоподобная пауза перед каждым запросом: 0.9–2.6 с по умолчанию
export const REQUEST_DELAY_MIN = Number(process.env.ALOT_DELAY_MIN_MS ?? 900);
export const REQUEST_DELAY_MAX = Number(process.env.ALOT_DELAY_MAX_MS ?? 2600);

function requestDelay() {
  const min = Math.min(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX);
  return Math.round(min + Math.random() * Math.abs(REQUEST_DELAY_MAX - REQUEST_DELAY_MIN));
}

const WORD_BOUND = new Set(['тг', 'вк', 'vk', 'vkontakte', 'tg', 'max', 'макс']);
const PREFIX_BOUND = new Set(['бот', 'чатбот', 'веб', 'web', 'сайт']);

export const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

function termRegex(term) {
  const k = norm(term);
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (WORD_BOUND.has(k)) return new RegExp(`(^|[^a-zа-я0-9])${esc}([^a-zа-я0-9]|$)`, 'i');
  if (PREFIX_BOUND.has(k)) return new RegExp(`(^|[^a-zа-я0-9])${esc}`, 'i');
  return new RegExp(esc, 'i');
}

const BOT_MATCHERS = BOT_TERMS.map((term) => ({ term, re: termRegex(term) }));
const SITE_MATCHERS = SITE_TERMS.map((term) => ({ term, re: termRegex(term) }));
const ACTION_MATCHERS = ACTION_TERMS.map((term) => ({ term, re: new RegExp(term, 'i') }));

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pick(matchers, text) {
  return matchers.filter(({ re }) => re.test(text)).map(({ term }) => term);
}

export function createMatcher({ categories = null, keywords = null } = {}) {
  const custom = keywords
    ? keywords.map((term) => ({ term, re: termRegex(term) }))
    : null;

  return function matchProject(project) {
    const cats = project.alotCategories ?? [];
    if (categories && !cats.some((c) => categories.includes(c))) return [];

    const title = norm(project.title);
    if (NEGATIVE_TERMS.some((term) => title.includes(term))) return [];

    if (custom) {
      const text = `${title} ${norm(htmlToText(project.body))}`;
      return pick(custom, text);
    }

    const topics = [...pick(BOT_MATCHERS, title), ...pick(SITE_MATCHERS, title)];
    if (!topics.length) return [];

    const catOk = cats.some((c) => PROG_CATEGORIES.includes(c));
    const actions = pick(ACTION_MATCHERS, title);
    if (!catOk && !actions.length) return [];

    return [...new Set([...topics, ...actions])];
  };
}

export const defaultMatcher = createMatcher();

export function buildRecord(project, hits) {
  return {
    id: project.internalId,
    title: project.title,
    description: htmlToText(project.body),
    url: project.url,
    shareUrl: project.shareUrl,
    source: SITE_NAMES[project.site] ?? project.site,
    sourceId: project.site,
    category: project.category,
    categories: project.alotCategories,
    price: project.price,
    priceValue: project.internalPrice ?? null,
    currency: project.currency,
    publishedAt: new Date(project.date).toISOString(),
    matchedKeywords: hits,
    foundAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------

export async function api(body, attempt = 1) {
  await sleep(requestDelay());

  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(2000 * attempt + Math.random() * 3000);
    return api(body, attempt + 1);
  }

  // при 429 не долбим сервер: ждём Retry-After (или хотя бы 30 с)
  if (res.status === 429) {
    if (attempt >= 3) throw new Error('HTTP 429: alot.pro ограничил частоту запросов');
    const retryAfter = Number(res.headers.get('retry-after') ?? 0);
    await sleep(Math.max(retryAfter * 1000, 30_000));
    return api(body, attempt + 1);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  if (json.responseCode !== 0) {
    // временные отказы API (например, responseCode 8) — пара повторных попыток с паузой
    if (attempt >= 3) throw new Error(`responseCode ${json.responseCode}`);
    await sleep(5000 + Math.random() * 10_000);
    return api(body, attempt + 1);
  }
  return json;
}

export async function getByIds(ids) {
  const json = await api({ action: 'getProjects', ids });
  return json.items ?? [];
}

async function maxInBlock(start, count) {
  const items = await getByIds(Array.from({ length: count }, (_, i) => start + i));
  return items.reduce((max, it) => Math.max(max, it.internalId), 0);
}

async function exists(id) {
  return (await getByIds([id])).length > 0;
}

// Ищет максимальный существующий internalId: ids на alot.pro растут последовательно.
export async function findHead() {
  let lo = 0;
  let hi = 1_000_000;
  while (!(await exists(hi))) {
    lo = hi;
    hi *= 2;
    if (hi > 1e9) return lo;
  }
  while (await exists(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > 1e9) break;
  }
  while (hi - lo > 200) {
    const mid = Math.floor((lo + hi) / 2);
    const found = await maxInBlock(mid, 100);
    if (found) lo = found;
    else hi = mid;
  }
  return (await maxInBlock(lo, 300)) || lo;
}

// Идёт вперёд пачками по 100 id. Пропуски в нумерации не обрывают проход:
// остановка только когда дошли до известной головы и пачка пришла неполной.
export async function scanNewProjects({ cursor, head, onProjects, maxBatches = 40 }) {
  let probe = cursor;
  let maxId = cursor;
  const target = Math.max(head ?? 0, cursor);

  for (let batch = 0; batch < maxBatches; batch++) {
    const items = await getByIds(Array.from({ length: BATCH }, (_, i) => probe + 1 + i));
    probe += BATCH;

    for (const item of items) {
      if (item.internalId > maxId) maxId = item.internalId;
    }
    if (onProjects) await onProjects(items);

    if (probe > target) {
      if (!items.length) break;
      if (items.length < BATCH) break;
    }
  }

  return { cursor: maxId, probe };
}
