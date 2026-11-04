import { call, client, errorText, uploadFile } from '../lib/api.js';
import { b, isFirefox } from '../lib/browser.js';
import { icon } from '../lib/icons.js';
import { appendLinkified, isLinkInput, looksLikeLink, normalizeLink, singleLink } from '../lib/links.js';
import { clearHistory, getConfig, getHistory, putHistory, updateConfig } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const standalone = params.has('view'); // opened in its own window (Firefox file picker)

let cfg;
let composing = null; // 'page' | 'link' | 'file' | 'text'
let tab = null;
let files = [];

for (const el of document.querySelectorAll('[data-icon]')) el.replaceChildren(icon(el.dataset.icon));
$('open-settings').replaceChildren(icon('settings'));
$('back').replaceChildren(icon('back'));
if (standalone) document.body.classList.add('standalone');

init();

async function init() {
  cfg = await getConfig();
  $('open-settings').onclick = () => { b.runtime.openOptionsPage(); window.close(); };
  if (!cfg.token) {
    $('setup').hidden = false;
    if (cfg.server) {
      $('setup-title').textContent = 'Signed out';
      $('setup-text').textContent = 'This browser is no longer connected to your Via account. Sign in again to keep sending and receiving.';
      $('setup-go').textContent = 'Sign in again';
    }
    $('setup-go').onclick = () => { b.runtime.openOptionsPage(); window.close(); };
    return;
  }

  $('app').hidden = false;
  $('device-name').textContent = cfg.deviceName ?? '';
  for (const btn of document.querySelectorAll('[role="tab"]')) btn.onclick = () => showTab(btn.dataset.tab);
  for (const btn of document.querySelectorAll('.option')) btn.onclick = () => openComposer(btn.dataset.kind);
  $('back').onclick = closeComposer;
  $('composer').onsubmit = (e) => { e.preventDefault(); send(); };
  $('select-all').onclick = toggleAll;
  $('text').oninput = updateTextCount;
  $('text').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); };
  $('link-url').oninput = () => { $('link-error').hidden = true; updateSendButton(); };
  $('link-url').onblur = () => { $('link-error').hidden = !$('link-url').value.trim() || isLinkInput($('link-url').value); };
  $('as-link').onclick = textToLink;
  setupFileInput();
  $('clear-history').onclick = async () => { await clearHistory(); renderHistory(); };

  loadTargets();
  refreshLimits();
  renderHistory();
  b.storage.onChanged.addListener((changes) => { if (changes.history) renderHistory(); });

  [tab] = await b.tabs.query({ active: true, currentWindow: true });
  if (tab?.title) $('page-hint').textContent = tab.title;

  if (standalone) openComposer(params.get('view'));
}

function showTab(name) {
  for (const btn of document.querySelectorAll('[role="tab"]')) btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  $('tab-send').hidden = name !== 'send';
  $('tab-history').hidden = name !== 'history';
}

// --- composer -----------------------------------------------------------------------------

async function openComposer(kind) {
  if (kind === 'file' && isFirefox && !standalone) {
    // Firefox closes the popup when the file picker opens, so pick files in a small window.
    await b.windows.create({ url: b.runtime.getURL('popup/popup.html?view=file'), type: 'popup', width: 400, height: 620 });
    window.close();
    return;
  }
  composing = kind;
  $('composer-title').textContent = { page: 'Send current page', link: 'Send link', file: 'Send file', text: 'Send text' }[kind];
  $('payload-page').hidden = kind !== 'page';
  $('payload-link').hidden = kind !== 'link';
  $('payload-text').hidden = kind !== 'text';
  $('payload-file').hidden = kind !== 'file';
  $('back').hidden = standalone;
  setStatus('');
  if (kind === 'page') {
    $('page-title').textContent = tab?.title || 'Untitled page';
    $('page-url').textContent = tab?.url || 'This page can’t be read by extensions.';
  }
  $('send-home').hidden = true;
  $('composer').hidden = false;
  if (kind === 'text') $('text').focus();
  if (kind === 'link') $('link-url').focus();
  if (kind === 'file' && !files.length) $('file').click();
  updateSendButton();
}

function closeComposer() {
  composing = null;
  $('composer').hidden = true;
  $('send-home').hidden = false;
}

function updateTextCount() {
  const max = cfg.limits?.max_text_length;
  const n = $('text').value.length;
  $('text-count').textContent = max ? `${n.toLocaleString()} / ${max.toLocaleString()}` : '';
  $('text-count').classList.toggle('over', Boolean(max && n > max));
  $('link-hint').hidden = !looksLikeLink($('text').value);
  updateSendButton();
}

/** "Looks like a link": move the text over to the link composer. */
function textToLink() {
  $('link-url').value = $('text').value.trim();
  $('text').value = '';
  updateTextCount();
  openComposer('link');
}

function setupFileInput() {
  const drop = $('drop');
  $('file').onchange = () => { addFiles($('file').files); $('file').value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
}

function addFiles(list) {
  files.push(...list);
  renderFiles();
  updateSendButton();
}

function renderFiles() {
  const max = cfg.limits?.max_file_size;
  $('file-list').replaceChildren(...files.map((f, i) => {
    const li = document.createElement('li');
    const tooBig = max && f.size > max;
    li.innerHTML = `<div class="row"><span class="grow ellipsis"></span><span></span>
      <button type="button" class="icon-btn" aria-label="Remove">×</button></div>
      <div class="progress" hidden><i></i></div>`;
    li.querySelector('.grow').textContent = f.name;
    const size = li.querySelector('.row span:nth-child(2)');
    size.textContent = tooBig ? `too large (max ${formatSize(max)})` : formatSize(f.size);
    if (tooBig) size.style.color = 'var(--danger)';
    li.querySelector('button').onclick = () => { files.splice(i, 1); renderFiles(); updateSendButton(); };
    return li;
  }));
}

// --- targets ------------------------------------------------------------------------------

async function loadTargets() {
  const api = client(cfg);
  let devices;
  try {
    devices = await api('/v1/devices');
  } catch (e) {
    $('targets').replaceChildren(Object.assign(document.createElement('p'), { className: 'status error', textContent: errorText(e) }));
    return;
  }
  const contacts = await api('/v1/contacts').then((c) => c.filter((x) => x.status === 'accepted')).catch(() => []);
  const others = devices.filter((d) => !d.current);
  const remembered = new Set(cfg.lastTargets ?? []);
  const anyRemembered = [...others.map((d) => d.id), ...contacts.map((c) => `@${c.username}`)].some((v) => remembered.has(v));

  const rows = [];
  if (!others.length && !contacts.length) {
    rows.push(Object.assign(document.createElement('p'), {
      className: 'muted small',
      textContent: 'No other devices yet. Install SendIt on another device to send to it.',
    }));
  }
  for (const d of others) {
    rows.push(targetRow(d.id, d.name, d.type, anyRemembered ? remembered.has(d.id) : true));
  }
  if (contacts.length) {
    rows.push(Object.assign(document.createElement('div'), { className: 'target-group', textContent: 'Contacts' }));
    for (const c of contacts) {
      const v = `@${c.username}`;
      rows.push(targetRow(v, c.username, 'contact', remembered.has(v)));
    }
  }
  $('targets').replaceChildren(...rows);
  updateSendButton();
}

function targetRow(value, name, kind, checked) {
  const label = document.createElement('label');
  label.className = 'target';
  label.innerHTML = '<input type="checkbox"><span class="grow"><span class="ellipsis"></span><span class="muted small"></span></span>';
  label.querySelector('.grow').before(icon(kind === 'contact' ? 'user' : kind));
  const input = label.querySelector('input');
  input.value = value;
  input.checked = checked;
  input.onchange = updateSendButton;
  label.querySelector('.ellipsis').textContent = name;
  label.querySelector('.small').textContent = kind === 'contact' ? 'Contact' : typeLabel(kind);
  return label;
}

function selectedTargets() {
  return [...document.querySelectorAll('#targets input:checked')].map((i) => i.value);
}

function toggleAll() {
  const boxes = [...document.querySelectorAll('#targets input')];
  const all = boxes.every((i) => i.checked);
  for (const i of boxes) i.checked = !all;
  updateSendButton();
}

function updateSendButton() {
  const n = selectedTargets().length;
  const boxes = document.querySelectorAll('#targets input');
  $('select-all').textContent = boxes.length && [...boxes].every((i) => i.checked) ? 'Select none' : 'Select all';
  $('select-all').hidden = boxes.length < 2;
  let ready = n > 0;
  if (composing === 'text') ready &&= $('text').value.trim().length > 0 && !$('text-count').classList.contains('over');
  if (composing === 'file') ready &&= files.length > 0 && files.every((f) => !cfg.limits?.max_file_size || f.size <= cfg.limits.max_file_size);
  if (composing === 'page') ready &&= Boolean(tab?.url);
  if (composing === 'link') ready &&= isLinkInput($('link-url').value);
  $('send').disabled = !ready;
  const contacts = selectedTargets().filter((t) => t.startsWith('@')).length;
  const noun = contacts ? (n === 1 ? 'recipient' : 'recipients') : (n === 1 ? 'device' : 'devices');
  $('send').textContent = n ? `Send to ${n} ${noun}` : 'Choose where to send';
}

// --- sending ------------------------------------------------------------------------------

async function send() {
  if ($('send').disabled) return;
  const to = selectedTargets();
  const api = client(cfg);
  $('send').disabled = true;
  setStatus(composing === 'file' ? 'Uploading… keep this open until it finishes.' : 'Sending…');
  try {
    if (composing === 'page') {
      await api('/v1/pushes', { method: 'POST', json: { kind: 'link', url: tab.url, title: tab.title || null, to } });
    } else if (composing === 'link') {
      const url = normalizeLink($('link-url').value);
      await api('/v1/pushes', { method: 'POST', json: { kind: 'link', url, title: $('link-title').value.trim() || null, to } });
    } else if (composing === 'text') {
      await api('/v1/pushes', { method: 'POST', json: { kind: 'note', body: $('text').value, to } });
    } else {
      const items = [...$('file-list').children];
      for (const [i, f] of files.entries()) {
        const bar = items[i].querySelector('.progress');
        bar.hidden = false;
        await uploadFile(cfg, f, to, (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
      }
    }
  } catch (e) {
    setStatus(errorText(e), 'error');
    $('send').disabled = false;
    return;
  }
  await updateConfig({ lastTargets: to });
  cfg.lastTargets = to;
  setStatus('Sent', 'ok');
  $('send-status').prepend(icon('check', 'sent-check'), ' ');
  setTimeout(() => {
    if (standalone) return window.close();
    if (composing === 'text') $('text').value = '';
    if (composing === 'link') $('link-url').value = $('link-title').value = '';
    files = [];
    renderFiles();
    updateTextCount();
    closeComposer();
  }, 900);
}

function setStatus(text, kind = '') {
  const el = $('send-status');
  el.className = `status ${kind}`;
  el.textContent = text;
}

/** Keep the server's size limits fresh for validation. */
async function refreshLimits() {
  try {
    const info = await call(cfg.server, '/v1/info');
    cfg = await updateConfig({ limits: info.limits, features: info.features });
    updateTextCount();
    if (files.length) renderFiles();
  } catch { /* offline: keep the cached limits */ }
}

// --- history ------------------------------------------------------------------------------

const STATUS = {
  opened: 'Opened',
  received: 'Not opened',
  copied: 'Copied',
  downloading: 'Downloading…',
  downloaded: 'Downloaded',
  cancelled: 'Download cancelled',
  failed: 'Download failed',
  unavailable: 'File no longer available',
  recalled: 'Recalled by sender',
};

async function renderHistory() {
  const history = await getHistory();
  $('history-count').textContent = history.length ? String(history.length) : '';
  $('history-empty').hidden = history.length > 0;
  $('clear-history').parentElement.hidden = history.length === 0;
  $('history').replaceChildren(...history.map(historyEntry));
}

function historyEntry(h) {
  const li = document.createElement('li');
  li.className = `entry${h.sender ? ' shared' : ''}`;
  const kindIcon = { link: 'link', note: 'text', file: 'file' }[h.kind] ?? 'other';
  li.innerHTML = `<span class="kind"></span>
    <div class="body"><span class="main"></span><span class="sub muted small ellipsis"></span><span class="meta"></span></div>
    <div class="actions"></div>`;
  li.querySelector('.kind').append(icon(kindIcon));
  const main = li.querySelector('.main');
  const sub = li.querySelector('.sub');
  if (h.kind === 'link') {
    main.textContent = h.title || h.url;
    sub.textContent = h.url;
  } else if (h.kind === 'note') {
    const openLink = (url) => openFromHistory(h, url);
    if (h.title) main.textContent = h.title;
    else appendLinkified(main, h.body ?? '', openLink);
    if (h.title && h.body) appendLinkified(sub, h.body, openLink);
    if (!h.title) main.classList.add('note');
  } else if (h.kind === 'file') {
    main.textContent = h.file?.name ?? 'File';
    sub.textContent = h.file ? formatSize(h.file.size) : '';
  }
  if (!sub.textContent) sub.remove();

  const meta = li.querySelector('.meta');
  const parts = [relativeTime(h.receivedAt)];
  if (h.from) parts.push(h.sender ? `shared by ${h.from}` : `from ${h.from}`);
  meta.textContent = parts.join(' · ') + ' · ';
  const status = document.createElement('span');
  status.textContent = STATUS[h.status] ?? '';
  if (['failed', 'unavailable', 'recalled'].includes(h.status)) status.className = 'bad';
  meta.append(status);

  const actions = li.querySelector('.actions');
  const action = (name, label, fn) => {
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(icon(name));
    btn.onclick = fn;
    actions.append(btn);
  };
  if (h.kind === 'link' && /^https?:/i.test(h.url ?? '')) {
    action('copy', 'Copy link', (e) => copy(e.currentTarget, h.url));
    action('open', 'Open', () => openFromHistory(h, h.url));
  } else if (h.kind === 'note') {
    action('copy', 'Copy text', (e) => copy(e.currentTarget, h.body ?? h.title ?? ''));
    const link = singleLink(h.body ?? h.title);
    if (link) action('open', 'Open link', () => openFromHistory(h, link));
  } else if (h.kind === 'file' && h.status === 'downloaded' && h.downloadId != null) {
    action('folder', 'Show in folder', () => b.downloads.show(h.downloadId));
  } else if (h.kind === 'file' && h.status === 'failed') {
    action('retry', 'Retry download', async () => {
      await putHistory({ id: h.id, status: 'downloading', attempts: 0 });
      b.runtime.sendMessage({ target: 'background', type: 'sync' }).catch(() => {});
    });
  }
  return li;
}

async function openFromHistory(h, url) {
  await b.tabs.create({ url });
  if (h.kind === 'link' && h.status === 'received') await putHistory({ id: h.id, status: 'opened' });
  window.close();
}

async function copy(btn, text) {
  await navigator.clipboard.writeText(text);
  btn.replaceChildren(icon('check'));
  setTimeout(() => btn.replaceChildren(icon('copy')), 1200);
}

// --- formatting ---------------------------------------------------------------------------

function typeLabel(type) {
  return { android: 'Android', ios: 'iPhone / iPad', desktop: 'Desktop', browser: 'Browser', cli: 'Command line' }[type] ?? 'Device';
}

function formatSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

function relativeTime(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day']];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return unit === 'second' ? 'just now' : rtf.format(Math.round(v), unit);
    v /= size;
  }
  return new Date(iso).toLocaleDateString();
}
