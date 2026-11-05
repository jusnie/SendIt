// Background: keeps a server-sent-events stream open, syncs the inbox, and handles what
// arrives. Links open in a tab, text goes to the clipboard, files go to the downloads folder.
// Runs as a service worker in Chrome and an event page in Firefox; an alarm restarts
// everything whenever the browser suspends it.
import { ApiError, call, client } from './lib/api.js';
import { b } from './lib/browser.js';
import { isWebUrl } from './lib/links.js';
import { getConfig, getHistory, getPending, putHistory, setPending, updateConfig } from './lib/store.js';

const ALARM = 'via-sync';
const WATCHDOG_MS = 70_000; // the server pings every ~25 s
const MAX_DOWNLOAD_ATTEMPTS = 3;
const HANDLED_LIMIT = 500;

// --- listeners (registered synchronously so a suspended worker is woken for them) -------

b.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarm();
  const cfg = await getConfig();
  if (reason === 'install' && !cfg.token) b.runtime.openOptionsPage();
  start();
});
b.runtime.onStartup.addListener(start);
b.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) start();
});
b.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'reconnect') reconnect();
  if (msg.type === 'sync') sync();
  if (msg.type === 'unlock') unlockWithPin(msg.pin, msg.itemId);
  if (msg.type === 'redownload') redownload(msg.itemId);
});

/** Re-download a file item from the server (history "Re-download" button). */
async function redownload(itemId) {
  const cfg = await getConfig();
  const item = await client(cfg)(`/v1/inbox/${itemId}`).catch(() => null);
  if (!item) return;
  const entry = {
    id: item.id, kind: item.kind, title: item.title, body: item.body, url: item.url,
    file: item.file ? { name: item.file.name, size: item.file.size, mime: item.file.mime } : null,
    sender: item.sender, from: item.sender ? `@${item.sender}` : await deviceName(cfg, item.source_device_id),
    createdAt: item.created_at, receivedAt: new Date().toISOString(),
  };
  await handle({ ...cfg, settings: { ...cfg.settings, pin: null } }, item);
  void entry;
}

/** Release a PIN-locked item when the entered PIN matches. */
async function unlockWithPin(pin, itemId) {
  const cfg = await getConfig();
  if (!cfg.settings.pin || pin !== cfg.settings.pin) {
    b.notifications.create(`via:pin`, { type: 'basic', iconUrl: 'icons/icon-48.png', title: 'Wrong PIN', message: 'That PIN did not match.' });
    return;
  }
  const history = await getHistory();
  const entry = history.find((h) => h.id === itemId && h.status === 'locked');
  if (!entry) return;
  const item = await client(cfg)(`/v1/inbox/${itemId}`).catch(() => null);
  if (!item) return;
  await handle({ ...cfg, settings: { ...cfg.settings, pin: null } }, item);
}
b.downloads.onChanged.addListener(onDownloadChanged);
b.notifications.onClicked.addListener(onNotificationClicked);

// --- connection -------------------------------------------------------------------------

let stream = null; // AbortController of the running SSE loop
let keepAlive = null;
let starting = null;

async function ensureAlarm() {
  if (!(await b.alarms.get(ALARM))) b.alarms.create(ALARM, { periodInMinutes: 1 });
}

/** Idempotent: make sure the stream is running (it syncs on connect), or sync if it is. */
function start() {
  starting ??= doStart().finally(() => { starting = null; });
  return starting;
}

async function doStart() {
  await ensureAlarm();
  const cfg = await getConfig();
  if (!cfg.token) return stop();
  if (stream) return sync();
  runStream();
}

function stop() {
  stream?.abort();
  stream = null;
  clearInterval(keepAlive);
  keepAlive = null;
}

function reconnect() {
  stop();
  start();
}

async function runStream() {
  const ctrl = new AbortController();
  stream = ctrl;
  // Calling an extension API every 20 s keeps Chrome's service worker alive while the
  // stream is open; without it the worker is suspended after 30 s of no events.
  keepAlive = setInterval(() => b.runtime.getPlatformInfo(), 20_000);
  let backoff = 1000;
  try {
    while (!ctrl.signal.aborted) {
      const cfg = await getConfig();
      if (!cfg.token) break;
      try {
        await readStream(cfg, ctrl.signal, () => { backoff = 1000; });
      } catch (e) {
        if (ctrl.signal.aborted) break;
        if (e instanceof ApiError && e.code === 'invalid_token') {
          await signedOutRemotely();
          break;
        }
        console.debug('SendIt: stream dropped', e);
      }
      await sleep(backoff + Math.random() * backoff * 0.3, ctrl.signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  } finally {
    if (stream === ctrl) stop();
  }
}

async function readStream(cfg, signal, onReady) {
  const conn = new AbortController();
  const abort = () => conn.abort();
  signal.addEventListener('abort', abort);
  let watchdog = setTimeout(abort, WATCHDOG_MS);
  try {
    const res = await fetch(`${cfg.server}/v1/inbox/events`, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: conn.signal,
    });
    if (res.status === 401) throw new ApiError(401, 'invalid_token', 'Device token rejected');
    if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(abort, WATCHDOG_MS);
      buf += value.replace(/\r\n?/g, '\n');
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const event = parseEvent(block);
        if (event) {
          if (event.type === 'ready') onReady();
          await onEvent(event);
        }
      }
    }
  } finally {
    clearTimeout(watchdog);
    signal.removeEventListener('abort', abort);
  }
}

function parseEvent(block) {
  let type = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length && type === 'message') return null;
  let payload = {};
  try { payload = JSON.parse(data.join('\n') || '{}'); } catch { /* ignore */ }
  return { type, data: payload };
}

async function onEvent({ type, data }) {
  if (type === 'ready' || type === 'push') sync();
  else if (type === 'recalled') await dropRecalled(data.id);
  else if (type === 'revoked') await signedOutRemotely();
  else if (type === 'rtc-offer') onRtcOffer(data);
}

/** Incoming WebRTC direct-transfer offer: answer it and save the file. */
async function onRtcOffer(data) {
  const cfg = await getConfig();
  if (!cfg.token || !data?.sdp) return;
  const { answerOffer } = await import('./lib/p2p.js');
  await answerOffer(cfg, data, async (file) => {
    try {
      const downloadId = await b.downloads.download({
        url: URL.createObjectURL(file),
        filename: sanitizeFilename(file.name),
        saveAs: cfg.settings.askWhereToSave,
        conflictAction: 'uniquify',
      });
      notify(`via:rtc-${Date.now()}`, file.name, 'Received directly over the local network.', data.from);
      void downloadId;
    } catch { /* user cancelled save dialog */ }
  });
}

async function signedOutRemotely() {
  stop();
  const cfg = await getConfig();
  if (!cfg.token) return;
  await updateConfig({ token: null });
  b.action.setBadgeText({ text: '!' });
  b.action.setBadgeBackgroundColor({ color: '#b42318' });
  notify('via:signed-out', 'SendIt: signed out', 'This browser was removed from your Via account. Open the extension to sign in again.');
}

// --- sync ---------------------------------------------------------------------------------

let syncing = null;
let syncAgain = false;

/** One sync at a time; a request during a sync runs another pass right after it. */
function sync() {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncAgain = false;
      try {
        await syncOnce();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'invalid_token') await signedOutRemotely();
        else console.debug('SendIt: sync failed', e);
        return;
      }
    } while (syncAgain);
  })().finally(() => { syncing = null; });
  return syncing;
}

async function syncOnce() {
  const cfg = await getConfig();
  if (!cfg.token) return;
  const api = client(cfg);
  await reconcilePending();
  let cursor = null;
  for (;;) {
    const q = new URLSearchParams({ limit: '50' });
    if (cursor) q.set('after', cursor);
    const page = await api(`/v1/inbox?${q}`);
    if (!page.items.length) return;
    const handled = await getHandled();
    const inFlight = new Set(Object.values(await getPending()).map((p) => p.itemId));
    // Files that failed too often wait for a retry from the history view.
    for (const h of await getHistory()) if (h.status === 'failed') inFlight.add(h.id);
    const acks = [];
    for (const item of page.items) {
      if (handled.includes(item.id)) {
        acks.push(item.id); // an earlier ack got lost
        continue;
      }
      if (inFlight.has(item.id)) continue;
      try {
        if (await handle(cfg, item)) {
          await markHandled(item.id);
          acks.push(item.id);
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'invalid_token') throw e;
        console.warn('SendIt: could not handle item', item.id, e);
      }
    }
    if (acks.length) await api('/v1/inbox/ack', { method: 'POST', json: { ids: acks } });
    cursor = page.cursor;
  }
}

/** Handle one item. Returns true when it can be acked now (files ack when saved). */
async function handle(cfg, item) {
  const trusted = item.sender == null;
  const entry = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    url: item.url,
    file: item.file ? { name: item.file.name, size: item.file.size, mime: item.file.mime } : null,
    sender: item.sender,
    from: item.sender ? `@${item.sender}` : await deviceName(cfg, item.source_device_id),
    createdAt: item.created_at,
    receivedAt: new Date().toISOString(),
  };

  // PIN protection: items from other devices/contacts stay locked until unlocked in the popup.
  if (cfg.settings.pin && item.sender != null) {
    await putHistory({ ...entry, status: 'locked' });
    notify(`via:${item.id}`, 'Locked item received', 'Open SendIt and enter your PIN to unlock it.', entry.from);
    return true;
  }

  if (item.kind === 'link') {
    const openable = isWebUrl(item.url);
    // Links from contacts and plain-http links wait for a click (docs/clients.md).
    const auto = openable && trusted && cfg.settings.autoOpenLinks && item.url.startsWith('https:');
    if (auto) await b.tabs.create({ url: item.url });
    await putHistory({ ...entry, status: auto ? 'opened' : 'received' });
    notify(`via:${item.id}`, item.title || hostOf(item.url), auto ? `Opened ${item.url}` : `${item.url}\nClick to open.`, entry.from,
      openable && !auto ? [{ title: 'Open' }] : undefined);
    return true;
  }

  if (item.kind === 'note') {
    const text = item.body ?? item.title ?? '';
    const auto = trusted && cfg.settings.autoCopyText;
    if (auto) await copyText(text);
    await putHistory({ ...entry, status: auto ? 'copied' : 'received' });
    notify(`via:${item.id}`, item.title || (auto ? 'Text copied to clipboard' : 'New text'), auto ? text : `${text}\nClick to copy.`, entry.from,
      !auto ? [{ title: 'Copy' }] : undefined);
    return true;
  }

  if (item.kind === 'file') {
    if (!item.file?.available) {
      await putHistory({ ...entry, status: 'unavailable' });
      notify(`via:${item.id}`, item.file?.name ?? 'File', 'This file is no longer available on the server.', entry.from);
      return true;
    }
    await startDownload(cfg, item, entry);
    return false;
  }

  return true; // unknown kind from a newer server: nothing to do
}

// --- files ------------------------------------------------------------------------------

async function startDownload(cfg, item, entry) {
  const pending = await getPending();
  const attempts = (await attemptsFor(item.id)) + 1;
  await putHistory({ ...entry, status: 'downloading', attempts });
  let downloadId;
  try {
    downloadId = await b.downloads.download({
      url: `${cfg.server}/v1/inbox/${item.id}/file`,
      headers: [{ name: 'Authorization', value: `Bearer ${cfg.token}` }],
      filename: sanitizeFilename(item.file.name),
      saveAs: cfg.settings.askWhereToSave,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    // Firefox rejects when the user cancels the save dialog.
    if (/cancel/i.test(e?.message ?? '')) return finishFile(item.id, 'cancelled');
    throw e;
  }
  pending[downloadId] = { itemId: item.id, size: item.file.size, attempts };
  await setPending(pending);
}

async function attemptsFor(itemId) {
  return (await getHistory()).find((h) => h.id === itemId)?.attempts ?? 0;
}

async function onDownloadChanged(delta) {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const pending = await getPending();
  const p = pending[delta.id];
  if (!p) return;
  delete pending[delta.id];
  await setPending(pending);

  const [dl] = await b.downloads.search({ id: delta.id });
  if (state === 'complete') {
    // The browser writes straight to disk, so the size is what can be checked here.
    const size = dl?.fileSize > 0 ? dl.fileSize : dl?.bytesReceived;
    if (size === p.size) return finishFile(p.itemId, 'downloaded', delta.id, dl?.filename);
    await b.downloads.removeFile(delta.id).catch(() => {});
    return failDownload(p, `size mismatch (${size} of ${p.size} bytes)`);
  }
  const error = delta.error?.current ?? dl?.error;
  if (error === 'USER_CANCELED') return finishFile(p.itemId, 'cancelled');
  return failDownload(p, error);
}

async function finishFile(itemId, status, downloadId = null, path = null) {
  const cfg = await getConfig();
  await putHistory({ id: itemId, status, downloadId, path });
  await markHandled(itemId);
  if (cfg.token) await call(cfg.server, `/v1/inbox/${itemId}/ack`, { method: 'POST', token: cfg.token }).catch(() => {});
  if (status === 'downloaded') {
    const entry = (await getHistory()).find((h) => h.id === itemId);
    notify(`via:${itemId}`, entry?.file?.name ?? 'File received', 'Saved to your downloads.', entry?.from, [{ title: 'Show' }]);
  }
}

async function failDownload(p, reason) {
  console.warn('SendIt: download failed', p.itemId, reason);
  if (p.attempts >= MAX_DOWNLOAD_ATTEMPTS) {
    // Not acked: the item stays on the server until it expires or another sync succeeds
    // after the user retries from the history.
    await putHistory({ id: p.itemId, status: 'failed' });
    notify(`via:${p.itemId}`, 'Download failed', 'A file could not be downloaded. Open SendIt to retry.');
    return;
  }
  sync();
}

/** Forget in-flight downloads the browser no longer knows about (e.g. after a restart). */
async function reconcilePending() {
  const pending = await getPending();
  let changed = false;
  for (const [id, p] of Object.entries(pending)) {
    const [dl] = await b.downloads.search({ id: Number(id) });
    if (dl?.state === 'in_progress') continue;
    delete pending[id];
    changed = true;
    if (dl?.state === 'complete' && (dl.fileSize > 0 ? dl.fileSize : dl.bytesReceived) === p.size) {
      await finishFile(p.itemId, 'downloaded', dl.id, dl.filename);
    }
  }
  if (changed) await setPending(pending);
}

async function dropRecalled(itemId) {
  const pending = await getPending();
  for (const [id, p] of Object.entries(pending)) {
    if (p.itemId !== itemId) continue;
    delete pending[id];
    await setPending(pending);
    await b.downloads.cancel(Number(id)).catch(() => {});
    await b.downloads.erase({ id: Number(id) }).catch(() => {});
    await putHistory({ id: itemId, status: 'recalled' });
  }
}

/** A name that is safe on every OS; the browser adds " (1)" on conflicts. */
function sanitizeFilename(name) {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 180);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s || 'via-file';
}

// --- clipboard ----------------------------------------------------------------------------

async function copyText(text) {
  if (b.offscreen) {
    // Chrome: service workers have no DOM, so an offscreen document does the copy.
    const url = b.runtime.getURL('offscreen/offscreen.html');
    const existing = await b.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (!existing.length) {
      await b.offscreen.createDocument({ url, reasons: ['CLIPBOARD'], justification: 'Copy text received from your other devices' });
    }
    const ok = await b.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    if (!ok) throw new Error('Clipboard write failed');
    return;
  }
  // Firefox: the event page has a DOM and clipboardWrite.
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// --- notifications ------------------------------------------------------------------------

function notify(id, title, message, from, buttons) {
  b.notifications.create(id, {
    type: 'basic',
    iconUrl: b.runtime.getURL('icons/icon-128.png'),
    title: from ? `${title} · from ${from}` : title,
    message: String(message).slice(0, 300),
    ...(buttons?.length ? { buttons } : {}),
  });
}

b.notifications.onButtonClicked.addListener(async (id, index) => {
  b.notifications.clear(id);
  const itemId = id.replace(/^via:/, '');
  const entry = (await getHistory()).find((h) => h.id === itemId);
  if (!entry) return;
  if (entry.kind === 'link' && isWebUrl(entry.url)) {
    await b.tabs.create({ url: entry.url });
    if (entry.status === 'received') await putHistory({ id: itemId, status: 'opened' });
  } else if (entry.kind === 'note') {
    await copyText(entry.body ?? entry.title ?? '');
    if (entry.status === 'received') await putHistory({ id: itemId, status: 'copied' });
  } else if (entry.kind === 'file' && entry.downloadId != null) {
    await b.downloads.show(entry.downloadId);
  }
});

async function onNotificationClicked(id) {
  b.notifications.clear(id);
  if (id === 'via:signed-out') return b.runtime.openOptionsPage();
  const itemId = id.replace(/^via:/, '');
  const entry = (await getHistory()).find((h) => h.id === itemId);
  if (!entry) return;
  if (entry.kind === 'link' && isWebUrl(entry.url)) {
    await b.tabs.create({ url: entry.url });
    if (entry.status === 'received') await putHistory({ id: itemId, status: 'opened' });
  } else if (entry.kind === 'note') {
    await copyText(entry.body ?? entry.title ?? '');
    if (entry.status === 'received') await putHistory({ id: itemId, status: 'copied' });
  } else if (entry.kind === 'file' && entry.downloadId != null) {
    b.downloads.show(entry.downloadId);
  }
}

// --- helpers ------------------------------------------------------------------------------

async function getHandled() {
  const { handled = [] } = await b.storage.local.get('handled');
  return handled;
}

async function markHandled(id) {
  const handled = await getHandled();
  if (handled.includes(id)) return;
  handled.push(id);
  await b.storage.local.set({ handled: handled.slice(-HANDLED_LIMIT) });
}

/** Name of one of our devices, from a cache refreshed at most every 10 minutes. */
async function deviceName(cfg, deviceId) {
  if (!deviceId) return null;
  const { deviceCache } = await b.storage.local.get('deviceCache');
  let cache = deviceCache;
  if (!cache || Date.now() - cache.at > 600_000 || !cache.names[deviceId]) {
    try {
      const devices = await client(cfg)('/v1/devices');
      cache = { at: Date.now(), names: Object.fromEntries(devices.map((d) => [d.id, d.name])) };
      await b.storage.local.set({ deviceCache: cache });
    } catch {
      return null;
    }
  }
  return cache.names[deviceId] ?? null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'Link'; }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Last, so every module-level binding above is initialized.
start();
