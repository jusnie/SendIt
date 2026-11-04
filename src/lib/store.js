// Everything the extension keeps lives in storage.local:
//   config   server, device token and id, username, device name, cached limits, settings
//   history  received items, newest first
//   pending  downloads in flight: { [downloadId]: { itemId, size, attempts } }
import { b } from './browser.js';

export const DEFAULT_SETTINGS = {
  askWhereToSave: false,
  autoOpenLinks: true,
  autoCopyText: true,
};

const HISTORY_LIMIT = 200;

export async function getConfig() {
  const { config = {} } = await b.storage.local.get('config');
  return { ...config, settings: { ...DEFAULT_SETTINGS, ...config.settings } };
}

export async function updateConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  await b.storage.local.set({ config: next });
  return next;
}

export async function updateSettings(patch) {
  const cfg = await getConfig();
  return updateConfig({ settings: { ...cfg.settings, ...patch } });
}

export async function getHistory() {
  const { history = [] } = await b.storage.local.get('history');
  return history;
}

/** Insert or update an entry by item id. */
export async function putHistory(entry) {
  const history = await getHistory();
  const i = history.findIndex((h) => h.id === entry.id);
  if (i >= 0) history[i] = { ...history[i], ...entry };
  else history.unshift(entry);
  await b.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
}

export async function clearHistory() {
  await b.storage.local.set({ history: [] });
}

export async function getPending() {
  const { pending = {} } = await b.storage.local.get('pending');
  return pending;
}

export async function setPending(pending) {
  await b.storage.local.set({ pending });
}
