import { call } from './api.js';

export const LAN_PERMISSIONS = [
  'http://192.168.*/*',
  'http://10.*/*',
  'http://172.16.*/*',
  'http://via.local/*',
  'http://sendit.local/*',
];

const HOSTS = ['via.local', 'sendit.local', '192.168.1.1', '192.168.0.1', '10.0.0.1', '172.16.0.1'];
const PORTS = ['', ':8080', ':3000', ':8787', ':80'];

/**
 * Probe common LAN locations for a Via server. Returns the first address that
 * answers /v1/info with name "via", or null. Silent: never throws, so it is safe
 * to run on popup open — it simply finds nothing if host permission is missing.
 */
export async function probeLan({ timeout = 1200, onProgress } = {}) {
  for (const host of HOSTS) {
    for (const port of PORTS) {
      const server = `http://${host}${port}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const info = await call(server, '/v1/info', { signal: ctrl.signal });
        clearTimeout(timer);
        if (info?.name === 'via') return server;
      } catch { /* keep probing */ }
      onProgress?.(server);
    }
  }
  return null;
}
