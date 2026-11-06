#!/usr/bin/env node
/**
 * Детектор АЭРО — наблюдатель воздушной обстановки.
 *
 * Опрашивает публичный API https://detector-aero.ru (PoW-сессия + /api/pub/v1/state),
 * отслеживает появление и отбой воздушных угроз в заданном районе
 * и рассылает уведомления (ntfy / Telegram / всплывающие окна Windows).
 *
 * Запуск:
 *   node watch.mjs            — работать постоянно (цикл опроса)
 *   node watch.mjs --once     — один цикл, вывод в консоль, без уведомлений
 *   node watch.mjs --test     — отправить тестовое уведомление во все каналы
 *   node watch.mjs --status   — показать текущую обстановку в районе
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const SESSION_PATH = path.join(ROOT, '.session.json');
const LOG_DIR = path.join(ROOT, 'logs');
const PID_PATH = path.join(ROOT, '.watch.pid');

const SITE = 'https://detector-aero.ru';
const API = SITE + '/api/pub/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const THREAT_LABEL = {
  uav: 'БПЛА', fpv: 'FPV-дрон', missile: 'Ракета', pvo: 'Работа ПВО',
  aviation: 'Авиация', mvsh: 'МВШ (воздушный шар)', threat: 'Угроза',
  unknown: 'Воздушная цель', airport: 'Аэропорт',
};
const SIGNAL_LABEL = { danger: 'Опасность', alarm: 'Тревога', shelter: 'Укрытие', clear: 'Отбой', info: 'Инфо' };
const THREAT_EMOJI = { uav: '🛸', fpv: '🛸', missile: '🚀', pvo: '💥', aviation: '✈️', mvsh: '🎈', threat: '⚠️', unknown: '⚠️' };

const args = new Set(process.argv.slice(2));
const MODE = args.has('--once') ? 'once'
  : args.has('--test') ? 'test'
  : args.has('--status') ? 'status'
  : args.has('--check') ? 'check'
  : args.has('--digest') ? 'digest'
  : 'loop';

// ---------------------------------------------------------------- утилиты

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `watch-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + '\n');
  } catch { /* лог не критичен */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const msk = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- конфиг

const config = readJson(CONFIG_PATH, null);
if (!config) {
  console.error('Нет config.json рядом с watch.mjs');
  process.exit(2);
}

// Локальные секреты (топик ntfy, токен бота) держим в config.local.json —
// он в .gitignore и не попадает в публичный репозиторий.
function deepMerge(base, extra) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = deepMerge(base[key] ?? {}, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}
const localConfig = readJson(path.join(ROOT, 'config.local.json'), null);
if (localConfig) deepMerge(config, localConfig);

// Секреты можно передавать через переменные окружения — удобно для GitHub Actions,
// где config.json лежит в открытом репозитории.
config.channels ??= {};
config.channels.ntfy ??= {};
config.channels.telegram ??= {};
if (process.env.NTFY_TOPIC) {
  config.channels.ntfy.enabled = true;
  config.channels.ntfy.topic = process.env.NTFY_TOPIC;
}
if (process.env.NTFY_SERVER) config.channels.ntfy.server = process.env.NTFY_SERVER;
if (process.env.TELEGRAM_BOT_TOKEN) {
  config.channels.telegram.enabled = true;
  config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
}
if (process.env.TELEGRAM_CHAT_ID) config.channels.telegram.chatId = process.env.TELEGRAM_CHAT_ID;

const watch = {
  zones: new Set(config.area?.zones ?? []),
  center: config.area?.center ?? null,
  radiusKm: config.area?.radiusKm ?? 0,
  threats: new Set(config.threats ?? Object.keys(THREAT_LABEL)),
  minSeverity: config.minSeverity ?? 1,
};

// ---------------------------------------------------------------- сессия / API

const zeroBits = (buf) => {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
};

function solvePow(challenge, difficulty) {
  for (let n = 0; n < 2e7; n++) {
    const digest = crypto.createHash('sha256').update(challenge + String(n)).digest();
    if (zeroBits(digest) >= difficulty) return String(n);
  }
  throw new Error('не удалось решить PoW');
}

let session = readJson(SESSION_PATH, null); // { cookie, expires }
let bootstrapped = false;

async function apiFetch(pathname, { retry = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (!session || !session.expires || session.expires * 1000 < Date.now() + 60_000) {
      await openSession();
    }
    let res;
    try {
      res = await fetch(API + pathname, {
        headers: { 'user-agent': UA, accept: 'application/json', cookie: session.cookie },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt < retry) { log('сеть:', err.message, '— повтор'); await sleep(3000 * (attempt + 1)); continue; }
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      log('сессия истекла, открываю новую');
      session = null;
      fs.rmSync(SESSION_PATH, { force: true });
      if (attempt < retry) continue;
      throw new Error('нет доступа к API (' + res.status + ')');
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 30);
      log(`слишком частые запросы, пауза ${wait} с`);
      await sleep(wait * 1000);
      if (attempt < retry) continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (attempt < retry) { log('HTTP', res.status, text.slice(0, 120), '— повтор'); await sleep(2000); continue; }
      throw new Error(`HTTP ${res.status}`);
    }
    bootstrapped = true;
    return res;
  }
}

async function openSession() {
  const ch = await (await fetch(API + '/challenge', { headers: { 'user-agent': UA, accept: 'application/json' } })).json();
  const nonce = solvePow(ch.challenge, ch.difficulty);
  const res = await fetch(API + '/session', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: ch.challenge, nonce }),
  });
  if (!res.ok) throw new Error('не удалось открыть сессию: HTTP ' + res.status);
  const data = await res.json();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  session = { cookie, expires: data.expires || Math.floor(Date.now() / 1000) + 3000 };
  writeJson(SESSION_PATH, session);
  log('сессия открыта, действует до', new Date(session.expires * 1000).toISOString());
}

// ---------------------------------------------------------------- состояние карты

let snapshot = null;      // { events: [], mark }
let pollsSinceFull = 0;

async function refreshState() {
  if (snapshot?.mark && pollsSinceFull < 20) {
    const res = await apiFetch('/state?since=' + encodeURIComponent(snapshot.mark));
    const inc = await res.json();
    if (applyIncrement(snapshot, inc)) { pollsSinceFull++; return snapshot; }
    snapshot = null;
  }
  const res = await apiFetch('/state');
  const data = await res.json();
  snapshot = { events: Array.isArray(data.events) ? data.events : [], mark: data.mark, online: data.online };
  pollsSinceFull = 0;
  return snapshot;
}

function applyIncrement(snap, inc) {
  if (!inc || !Array.isArray(inc.changed) || !Array.isArray(inc.dropped)) return false;
  const dropped = new Set(inc.dropped);
  const changed = new Map(inc.changed.map((e) => [e.id, e]));
  let events = snap.events.filter((e) => !dropped.has(e.id) && !changed.has(e.id)).concat(inc.changed);
  if (inc.window_since) events = events.filter((e) => !e.event_time || e.event_time >= inc.window_since);
  if (typeof inc.events_total === 'number' && events.length !== inc.events_total) return false;
  snap.events = events;
  if (inc.mark) snap.mark = inc.mark;
  return true;
}

// ---------------------------------------------------------------- отбор событий

function distanceTo(event) {
  if (!watch.center || typeof event.lat !== 'number' || typeof event.lon !== 'number') return null;
  return haversineKm(watch.center, { lat: event.lat, lon: event.lon });
}

function inArea(event) {
  const zones = Array.isArray(event.zones) ? event.zones : [];
  if (zones.some((z) => watch.zones.has(z))) return true;
  if (watch.zones.has(event.zone_id)) return true;
  const d = distanceTo(event);
  return d !== null && d <= watch.radiusKm;
}

function isDanger(event) {
  return event.status === 'active' && event.signal_type !== 'clear' && event.signal_type !== 'info'
    && watch.threats.has(event.threat_type) && (event.severity ?? 0) >= watch.minSeverity;
}

function isClear(event) {
  return event.signal_type === 'clear' || event.status === 'resolved';
}

function relevant(events) {
  return events.filter((e) => inArea(e)).sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)));
}

// ---------------------------------------------------------------- форматирование

function threatWord(types) {
  const list = [...new Set(types)].map((t) => THREAT_LABEL[t] ?? t);
  if (list.length === 1) return list[0];
  if (list.includes('БПЛА') && list.every((t) => t === 'БПЛА' || t === 'FPV-дрон')) return 'БПЛА';
  return list.join(', ');
}

function placeList(events) {
  const seen = new Map();
  for (const e of events) {
    const name = e.place_name || e.zone_id || 'без названия';
    const d = distanceTo(e);
    const key = name;
    if (!seen.has(key) || (d !== null && d < (seen.get(key)?.d ?? Infinity))) {
      seen.set(key, { name, d, time: e.event_time, threat: e.threat_type });
    }
  }
  return [...seen.values()].sort((a, b) => (a.d ?? 999) - (b.d ?? 999));
}

function dangerMessage(events) {
  const places = placeList(events);
  const word = threatWord(events.map((e) => e.threat_type));
  const emoji = THREAT_EMOJI[events[0]?.threat_type] ?? '⚠️';
  const lines = places.slice(0, 12).map((p) => `• ${p.name}${p.d && p.d > 2 ? ` (~${Math.round(p.d)} км)` : ''}`);
  const when = msk(events[0].event_time);
  return {
    title: `${emoji} Опасность: ${word}`,
    body: `${lines.join('\n')}\n\n${when} МСК · detector-aero.ru`,
    priority: 5,
    tags: 'rotating_light,warning',
  };
}

function clearMessage(events) {
  const places = placeList(events);
  const word = threatWord(events.map((e) => e.threat_type));
  return {
    title: `✅ Отбой: ${word}`,
    body: `${places.map((p) => p.name).join(', ')}\n\nОтбой по данным detector-aero.ru · ${msk(new Date().toISOString())} МСК`,
    priority: 3,
    tags: 'white_check_mark',
  };
}

function statusMessage(events) {
  const places = placeList(events);
  if (!places.length) return { title: 'Спокойно', body: 'Активных воздушных угроз в районе нет.', priority: 2, tags: 'zzz' };
  return {
    title: `Активных угроз: ${places.length}`,
    body: places.map((p) => `• ${p.name} — ${THREAT_LABEL[p.threat] ?? p.threat}${p.d ? ` (~${Math.round(p.d)} км)` : ''}`).join('\n'),
    priority: 4,
    tags: 'warning',
  };
}

// Часовая сводка: приходит всегда, даже когда в небе спокойно.
function digestMessage(active, recentEvents, windowMinutes = 60) {
  const places = placeList(active);
  const time = msk(new Date().toISOString());
  const recentWord = recentEvents.length
    ? `За последние ${windowMinutes} мин: ${recentEvents.length} ${plural(recentEvents.length, 'событие', 'события', 'событий')}.`
    : `За последние ${windowMinutes} мин новых событий не было.`;

  if (!places.length) {
    return {
      title: '🟢 Сводка: спокойно',
      body: `Активных воздушных угроз в районе нет.\n${recentWord}\n\n${time} МСК · detector-aero.ru`,
      priority: 2,
      tags: 'white_check_mark',
    };
  }

  const lines = places.slice(0, 12).map((p) => `• ${p.name} — ${THREAT_LABEL[p.threat] ?? p.threat}${p.d && p.d > 2 ? ` (~${Math.round(p.d)} км)` : ''}`);
  return {
    title: `🔴 Сводка: опасность (${places.length})`,
    body: `${lines.join('\n')}\n\n${recentWord}\n\n${time} МСК · detector-aero.ru`,
    priority: 4,
    tags: 'rotating_light',
  };
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

// ---------------------------------------------------------------- каналы

async function sendNtfy(msg) {
  const cfg = config.channels?.ntfy;
  if (!cfg?.enabled || !cfg.topic) return { channel: 'ntfy', skipped: true };
  const base = (cfg.server || 'https://ntfy.sh').replace(/\/$/, '');
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: cfg.topic,
        title: msg.title,
        message: msg.body,
        priority: msg.priority ?? 3,
        tags: (msg.tags ?? 'warning').split(','),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return { channel: 'ntfy', ok: res.ok, status: res.status };
  } catch (err) {
    return { channel: 'ntfy', ok: false, error: err.message };
  }
}

async function sendTelegram(msg) {
  const cfg = config.channels?.telegram;
  if (!cfg?.enabled || !cfg.botToken || !cfg.chatId) return { channel: 'telegram', skipped: true };
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: `${msg.title}\n\n${msg.body}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    return { channel: 'telegram', ok: res.ok, status: res.status };
  } catch (err) {
    return { channel: 'telegram', ok: false, error: err.message };
  }
}

function sendWindowsToast(msg) {
  const cfg = config.channels?.windowsToast;
  if (!cfg?.enabled) return { channel: 'toast', skipped: true };
  if (process.platform !== 'win32') return { channel: 'toast', skipped: true };
  const script = path.join(ROOT, 'windows-toast.ps1');
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Title', msg.title, '-Body', msg.body,
    ], { stdio: 'ignore', windowsHide: true, detached: true });
    child.on('error', (err) => log('канал toast: ' + err.message));
    child.unref();
    return { channel: 'toast', ok: true };
  } catch (err) {
    return { channel: 'toast', ok: false, error: err.message };
  }
}

async function notify(msg) {
  const results = [];
  for (const fn of [sendNtfy, sendTelegram]) results.push(await fn(msg));
  results.push(sendWindowsToast(msg));
  const active = results.filter((r) => !r.skipped);
  for (const r of active) {
    if (r.ok === false) log(`канал ${r.channel}: ошибка — ${r.error || 'HTTP ' + r.status}`);
  }
  if (!active.length) log('нет включённых каналов уведомлений — сообщение только в лог:', msg.title);
  return results;
}

// ---------------------------------------------------------------- состояние наблюдателя

let state = readJson(STATE_PATH, { announced: {}, lastPoll: null, lastError: null });
if (!state.announced) state.announced = {};
let pollCount = 0;

function saveState() {
  // храним только записи за последние 12 часов
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (const [id, info] of Object.entries(state.announced)) {
    if (new Date(info.at).getTime() < cutoff) delete state.announced[id];
  }
  writeJson(STATE_PATH, state);
}

// ---------------------------------------------------------------- один цикл

async function tick({ announce = true, verbose = false } = {}) {
  const snap = await refreshState();
  const events = relevant(snap.events);
  const active = events.filter(isDanger);
  const activeIds = new Set(active.map((e) => e.id));

  const fresh = active.filter((e) => !state.announced[e.id]);
  const clearedIds = Object.keys(state.announced).filter((id) => !activeIds.has(id));

  if (verbose) {
    log(`событий в районе: ${events.length}, активных угроз: ${active.length}`);
    for (const e of events.slice(0, 20)) {
      const d = distanceTo(e);
      log(`  ${SIGNAL_LABEL[e.signal_type] ?? e.signal_type} · ${THREAT_LABEL[e.threat_type] ?? e.threat_type} · ${e.place_name}${d ? ` (~${Math.round(d)} км)` : ''} · ${msk(e.event_time)}`);
    }
  }

  const sent = [];
  if (announce && fresh.length) {
    const msg = dangerMessage(fresh);
    await notify(msg);
    for (const e of fresh) state.announced[e.id] = { at: new Date().toISOString(), place: e.place_name, threat: e.threat_type };
    sent.push('danger:' + fresh.length);
    log(`→ уведомление об опасности: ${fresh.length} событий (${fresh.map((e) => e.place_name).join(', ')})`);
  }

  if (announce && clearedIds.length) {
    const clearedEvents = clearedIds.map((id) => {
      const e = snap.events.find((x) => x.id === id);
      return e || { place_name: state.announced[id]?.place, threat_type: state.announced[id]?.threat, event_time: new Date().toISOString() };
    });
    const msg = clearMessage(clearedEvents);
    await notify(msg);
    for (const id of clearedIds) delete state.announced[id];
    sent.push('clear:' + clearedIds.length);
    log(`→ уведомление об отбое: ${clearedIds.length} (${clearedEvents.map((e) => e.place_name).join(', ')})`);
  }

  state.lastPoll = new Date().toISOString();
  state.lastError = null;
  saveState();

  pollCount++;
  if (pollCount % 15 === 0) {
    log(`сердцебиение: опросов ${pollCount}, активных угроз ${active.length}, событий в районе ${events.length}`);
  }

  if (MODE === 'status') {
    const msg = statusMessage(active);
    console.log(`\n${msg.title}\n${msg.body}\n`);
  }
  return { events, active, fresh, clearedIds, sent };
}

// ---------------------------------------------------------------- основной режим

async function main() {
  if (MODE === 'test') {
    const msg = { title: '🛸 Тест уведомлений', body: 'Если вы видите это сообщение — уведомления от Детектор АЭРО настроены.', priority: 4, tags: 'test_tube' };
    const res = await notify(msg);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (MODE === 'digest') {
    // часовая сводка: состояние не меняем, уведомление отправляем всегда
    const snap = await refreshState();
    const events = relevant(snap.events);
    const active = events.filter(isDanger);
    const since = Date.now() - 60 * 60 * 1000;
    const recent = events.filter((e) => e.event_time && new Date(e.event_time).getTime() >= since);
    const msg = digestMessage(active, recent);
    log(`сводка: активных угроз ${active.length}, событий за час ${recent.length}`);
    await notify(msg);
    return;
  }

  if (MODE === 'check') {
    // одиночная проверка с уведомлениями — режим для GitHub Actions и cron
    const result = await tick({ announce: true, verbose: true });
    log(`проверка завершена: событий в районе ${result.events.length}, активных угроз ${result.active.length}`);
    return;
  }

  if (MODE === 'status' || MODE === 'once') {
    await tick({ announce: false, verbose: true });
    if (MODE === 'status') {
      const snap = await refreshState();
      const msg = statusMessage(relevant(snap.events).filter(isDanger));
      console.log(`\n${msg.title}\n${msg.body}\n`);
    }
    return;
  }

  // защита от двойного запуска: PID жив И состояние обновлялось недавно
  let prevPid = 0;
  try { prevPid = Number(fs.readFileSync(PID_PATH, 'utf8').trim() || 0); } catch { prevPid = 0; }
  const lastPollAge = state.lastPoll ? Date.now() - new Date(state.lastPoll).getTime() : Infinity;
  if (prevPid && prevPid !== process.pid && lastPollAge < 5 * 60 * 1000) {
    let alive = false;
    try { process.kill(prevPid, 0); alive = true; } catch { alive = false; }
    if (alive) { return; } // уже работает другой экземпляр — тихо выходим
  }
  fs.writeFileSync(PID_PATH, String(process.pid));

  const interval = Math.max(20, config.pollSeconds ?? 45) * 1000;
  const digestMinutes = Number(config.digestMinutes ?? 0);
  log(`старт наблюдения: ${config.area?.name ?? 'район'}, опрос каждые ${interval / 1000} с` +
    (digestMinutes > 0 ? `, сводка каждые ${digestMinutes} мин` : ''));
  let backoff = 0;

  process.on('SIGINT', () => { log('остановлено пользователем'); fs.rmSync(PID_PATH, { force: true }); process.exit(0); });
  process.on('SIGTERM', () => { fs.rmSync(PID_PATH, { force: true }); process.exit(0); });

  for (;;) {
    try {
      const result = await tick({ announce: true });
      if (pollCount === 1) log(`первый опрос: событий в районе ${result.events.length}, активных угроз ${result.active.length}`);

      // сводка по расписанию (независимо от того, были ли события)
      if (digestMinutes > 0) {
        const lastMs = state.lastDigest ? new Date(state.lastDigest).getTime() : 0;
        if (Date.now() - lastMs >= digestMinutes * 60_000) {
          const since = Date.now() - digestMinutes * 60_000;
          const recent = result.events.filter((e) => e.event_time && new Date(e.event_time).getTime() >= since);
          await notify(digestMessage(result.active, recent, digestMinutes));
          state.lastDigest = new Date().toISOString();
          saveState();
          log(`→ сводка: активных угроз ${result.active.length}, событий за ${digestMinutes} мин ${recent.length}`);
        }
      }

      backoff = 0;
      await sleep(interval);
    } catch (err) {
      state.lastError = err.message;
      state.lastPoll = new Date().toISOString();
      saveState();
      backoff = Math.min(backoff + 1, 5);
      const wait = Math.min(interval * 2 ** backoff, 10 * 60 * 1000);
      log(`ошибка: ${err.message}; повтор через ${Math.round(wait / 1000)} с`);
      await sleep(wait);
    }
  }
}

main().catch((err) => {
  log('фатальная ошибка:', err.stack || err.message);
  process.exit(1);
});
