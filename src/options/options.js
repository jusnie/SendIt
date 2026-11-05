import { ApiError, call, client, errorText, normalizeServer, originPattern, withSession } from '../lib/api.js';
import { LAN_PERMISSIONS, probeLan } from '../lib/lan.js';
import { b } from '../lib/browser.js';
import { icon } from '../lib/icons.js';
import { getConfig, updateConfig, updateSettings } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['step-server', 'step-account', 'step-done', 'settings'];

// Address of the managed Via server offered as the default choice.
const VIA_SERVER = 'https://via.sendit.app';

let cfg;
let pending = null; // onboarding: { server, info }

init();

async function init() {
  cfg = await getConfig();
  $('step-server').onsubmit = onServer;

  $('step-account').onsubmit = onAccount;
  $('account-back').onclick = () => show('step-server');
  $('done-settings').onclick = openSettings;
  $('rename').onsubmit = onRename;
  $('accepts-shares').onchange = onAcceptsShares;
  $('remove').onsubmit = onRemove;
  $('forget').onclick = () => signOutLocally();
  for (const el of document.querySelectorAll('[data-setting]')) {
    el.onchange = async () => {
      cfg = await updateSettings({ [el.dataset.setting]: el.checked });
      status('prefs-status', 'Saved', 'ok');
    };
  }
  if (cfg.token) openSettings();
  else startOnboarding();
}

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
  const focus = $(view).querySelector('input:not([type="checkbox"])');
  focus?.focus();
}

function status(id, text, kind = '') {
  $(id).className = `status ${kind}`;
  $(id).textContent = text;
}

function busy(button, on) {
  button.disabled = on;
}

// --- onboarding ---------------------------------------------------------------------------

function startOnboarding() {
  const saved = cfg.server ?? '';
  const isVia = saved === '' || saved === VIA_SERVER;
  $('type-via').checked = isVia;
  $('type-custom').checked = !isVia && saved.startsWith('https://');
  $('type-lan').checked = !isVia && !saved.startsWith('https://');
  $('server').value = isVia ? VIA_SERVER : saved;
  $('server').readOnly = isVia;
  $('server').placeholder = $('type-lan').checked ? 'http://192.168.1.10:8080' : 'https://via.example.com';
  for (const el of document.querySelectorAll('input[name="server-type"]')) {
    el.onchange = () => {
      const via = $('type-via').checked;
      const lan = $('type-lan').checked;
      $('server').readOnly = via;
      $('server').placeholder = lan ? 'Detecting on your network…' : 'https://via.example.com';
      $('server').value = via ? VIA_SERVER : (cfg.server && cfg.server !== VIA_SERVER ? cfg.server : '');
      if (lan) detectLan(true); // auto-fill the LAN address when LAN is chosen
    };
  }
  status('server-status', cfg.server ? 'This browser was signed out. Sign in again to reconnect.' : '');
  show('step-server');
  if ($('type-lan').checked) detectLan(true); // auto-detect on load if LAN was saved
}

// Probe common LAN locations for a Via server and fill in the first one that answers.
// With `auto`, runs silently when the LAN option is selected (permission already
// granted or not — on failure the field just stays editable).
async function detectLan(auto = false) {
  if (!auto) status('server-status', 'Looking for a server on your network…');
  try {
    if (!auto) {
      const granted = await b.permissions.request({ origins: LAN_PERMISSIONS });
      if (!granted) return status('server-status', 'Permission for local network addresses was denied.', 'error');
    }
    const found = await probeLan();
    if (found) {
      $('server').value = found;
      $('server').placeholder = 'http://192.168.1.10:8080';
      status('server-status', auto ? `Found ${found}` : `Found a Via server at ${found}`, 'ok');
    } else if (!auto) {
      status('server-status', 'No Via server found on your network. Enter its address manually.', 'error');
    } else {
      $('server').placeholder = 'http://192.168.1.10:8080';
      status('server-status', '');
    }
  } catch (err) {
    if (!auto) status('server-status', errorText(err), 'error');
  }
}

async function onServer(e) {
  e.preventDefault();
  let server;
  try {
    server = normalizeServer($('server').value);
  } catch {
    return status('server-status', 'That doesn’t look like a web address.', 'error');
  }
  busy($('server-go'), true);
  try {
    // Must be the first await: browsers only show the prompt during the click.
    const granted = await b.permissions.request({ origins: [originPattern(server)] });
    if (!granted) return status('server-status', 'SendIt needs permission to talk to your server to work.', 'error');
    status('server-status', 'Checking…');
    const info = await call(server, '/v1/info').catch((err) => {
      throw err instanceof ApiError && err.status ? new Error('That address answered, but it isn’t a Via server.') : err;
    });
    if (info?.name !== 'via' || info.api_version !== 1) {
      throw new Error(info?.name === 'via'
        ? `This server speaks API version ${info.api_version}; this extension needs version 1.`
        : 'That address answered, but it isn’t a Via server.');
    }
    pending = { server, info };
    $('account-server').textContent = server.replace(/^https?:\/\//, '');
    $('username').value = cfg.username ?? '';
    $('device-name').value ||= cfg.deviceName ?? defaultDeviceName();
    status('server-status', '');
    status('account-status', server.startsWith('http:') && !isLocal(server)
      ? 'This server doesn’t use https, so your password and items travel unencrypted.' : '');
    show('step-account');
    if ($('username').value) $('password').focus();
  } catch (err) {
    status('server-status', errorText(err), 'error');
  } finally {
    busy($('server-go'), false);
  }
}

async function onAccount(e) {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  const name = $('device-name').value.trim();
  if (!username || !password || !name) return status('account-status', 'Fill in all three fields.', 'error');
  const { server, info } = pending;
  busy($('account-go'), true);
  status('account-status', 'Connecting…');
  try {
    const created = await withSession(server, username, password, (session) =>
      call(server, '/v1/devices', { method: 'POST', token: session, json: { name, type: 'browser' } }));
    await b.storage.local.remove(['handled', 'pending', 'deviceCache', 'lastTargets']);
    cfg = await updateConfig({
      server,
      username,
      token: created.token,
      deviceId: created.device.id,
      deviceName: created.device.name,
      limits: info.limits,
      features: info.features,
      lastTargets: [],
    });
    $('password').value = '';
    b.action.setBadgeText({ text: '' });
    b.runtime.sendMessage({ target: 'background', type: 'reconnect' }).catch(() => {});
    $('done-mark').replaceChildren(icon('check'));
    $('done-name').textContent = created.device.name;
    status('account-status', '');
    show('step-done');
  } catch (err) {
    status('account-status', errorText(err), 'error');
  } finally {
    busy($('account-go'), false);
  }
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function isLocal(server) {
  const host = new URL(server).hostname;
  return host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

// --- settings -----------------------------------------------------------------------------

async function openSettings() {
  cfg = await getConfig();
  $('rename-name').value = cfg.deviceName ?? '';
  $('rename-user').textContent = cfg.username ?? 'your account';
  $('fact-server').textContent = cfg.server;
  $('fact-user').textContent = cfg.username ?? '';
  for (const el of document.querySelectorAll('[data-setting]')) el.checked = Boolean(cfg.settings[el.dataset.setting]);
  $('pin').value = cfg.settings.pin ?? '';
  show('settings');
  $('rename-name').blur();
  checkConnection();
}

async function checkConnection() {
  const fact = $('fact-conn');
  try {
    const me = await client(cfg)('/v1/devices/me');
    fact.className = 'ok';
    fact.textContent = 'Connected';
    $('accepts-shares').checked = me.accepts_shares;
    if (me.name !== cfg.deviceName) {
      cfg = await updateConfig({ deviceName: me.name });
      $('rename-name').value = me.name;
    }
  } catch (err) {
    fact.className = 'bad';
    fact.textContent = errorText(err);
    if (err instanceof ApiError && err.code === 'invalid_token') {
      await updateConfig({ token: null });
      startOnboarding();
    }
  }
}

/**
 * Change this device. Current servers take PATCH /v1/devices/me with the device token; older
 * ones only allow PATCH /v1/devices/{id} with a session, so fall back to the password.
 */
async function updateDevice(patch, password) {
  if (password) {
    return withSession(cfg.server, cfg.username, password, (session) =>
      call(cfg.server, `/v1/devices/${cfg.deviceId}`, { method: 'PATCH', token: session, json: patch }));
  }
  return client(cfg)('/v1/devices/me', { method: 'PATCH', json: patch });
}

const needsSession = (err) => err instanceof ApiError && (err.status === 404 || err.status === 405);

async function onRename(e) {
  e.preventDefault();
  const name = $('rename-name').value.trim();
  if (!name) return status('rename-status', 'Enter a name.', 'error');
  const passwordBox = $('rename-password');
  const password = passwordBox.hidden ? null : $('rename-pass').value;
  if (!passwordBox.hidden && !password) return status('rename-status', 'Enter your password.', 'error');
  busy($('rename-go'), true);
  try {
    const device = await updateDevice({ name }, password);
    cfg = await updateConfig({ deviceName: device.name });
    $('rename-pass').value = '';
    passwordBox.hidden = true;
    status('rename-status', `Renamed to “${device.name}”.`, 'ok');
  } catch (err) {
    if (!password && needsSession(err)) {
      passwordBox.hidden = false;
      $('rename-pass').focus();
      status('rename-status', '');
    } else {
      status('rename-status', errorText(err), 'error');
    }
  } finally {
    busy($('rename-go'), false);
  }
}

async function onAcceptsShares() {
  const box = $('accepts-shares');
  try {
    await updateDevice({ accepts_shares: box.checked });
    status('prefs-status', 'Saved', 'ok');
  } catch (err) {
    box.checked = !box.checked;
    status('prefs-status', needsSession(err)
      ? 'This server is too old to change this from here. Use Via’s web UI instead.'
      : errorText(err), 'error');
  }
}

async function onRemove(e) {
  e.preventDefault();
  const password = $('remove-pass').value;
  if (!password) return status('remove-status', 'Enter your password to remove this browser.', 'error');
  busy($('remove-go'), true);
  status('remove-status', 'Removing…');
  const token = cfg.token;
  try {
    await withSession(cfg.server, cfg.username, password, async (session) => {
      // Forget the token first so the background doesn't treat the removal as unexpected.
      await updateConfig({ token: null });
      b.runtime.sendMessage({ target: 'background', type: 'reconnect' }).catch(() => {});
      try {
        await call(cfg.server, `/v1/devices/${cfg.deviceId}`, { method: 'DELETE', token: session });
      } catch (err) {
        if (err.status !== 404) {
          await updateConfig({ token });
          b.runtime.sendMessage({ target: 'background', type: 'reconnect' }).catch(() => {});
          throw err;
        }
      }
    });
    $('remove-pass').value = '';
    await signOutLocally();
  } catch (err) {
    status('remove-status', errorText(err), 'error');
  } finally {
    busy($('remove-go'), false);
  }
}

async function signOutLocally() {
  cfg = await updateConfig({ token: null, deviceId: null });
  await b.storage.local.remove(['handled', 'pending', 'deviceCache']);
  b.runtime.sendMessage({ target: 'background', type: 'reconnect' }).catch(() => {});
  status('remove-status', '');
  startOnboarding();
  status('server-status', 'Signed out. Connect again whenever you like.');
}
