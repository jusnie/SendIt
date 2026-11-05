import { call } from './api.js';

export const LAN_PERMISSIONS = [
  'http://192.168.*/*',
  'http://10.*/*',
  'http://172.16.*/*',
  'http://via.local/*',
  'http://sendit.local/*',
];

const HOSTS = ['via.local', 'sendit.local', '127.0.0.1', '192.168.1.1', '192.168.0.1', '10.0.0.1', '172.16.0.1'];
const PORTS = ['', ':8080', ':3000', ':8787', ':80'];

/**
 * Probe common LAN locations for a Via server. All candidates are probed in
 * parallel with a short timeout, so the whole scan finishes in ~1s.
 * Returns the first address that answers /v1/info with name "via", or null.
 * Silent: never throws, so it is safe to run on popup open.
 */
export async function probeLan({ timeout = 900 } = {}) {
  const candidates = HOSTS.flatMap((host) => PORTS.map((port) => `http://${host}${port}`));
  const results = await Promise.allSettled(candidates.map(async (server) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const info = await call(server, '/v1/info', { signal: ctrl.signal });
      return info?.name === 'via' ? server : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }));
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null)).find(Boolean) ?? null;
}
