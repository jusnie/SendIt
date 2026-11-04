// Thin client for the Via HTTP API (see Via's docs/api.md).

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** "via.example.com/" → "https://via.example.com". Keeps a path prefix for sub-path installs. */
export function normalizeServer(input) {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** Host permission pattern for a server. Match patterns ignore ports, so this covers them. */
export function originPattern(server) {
  const u = new URL(server);
  return `${u.protocol}//${u.hostname}/*`;
}

export async function call(server, path, { token, method = 'GET', json, body, headers = {}, signal } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(server + path, { method, headers: h, body, signal, cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Could not reach the server');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    throw new ApiError(res.status, err.code ?? `http_${res.status}`, err.message ?? res.statusText, retryAfter);
  }
  return data;
}

/** A caller bound to the configured server and device token. */
export function client(cfg) {
  return (path, opts = {}) => call(cfg.server, path, { token: cfg.token, ...opts });
}

/**
 * Run `fn(sessionToken)` with a short-lived session. Device tokens can't manage devices, so
 * renaming or removing this device asks for the password; the session is never stored.
 */
export async function withSession(server, username, password, fn) {
  const { token } = await call(server, '/v1/auth/login', { method: 'POST', json: { username, password } });
  try {
    return await fn(token);
  } finally {
    await call(server, '/v1/auth/logout', { method: 'POST', token }).catch(() => {});
  }
}

export function errorText(e) {
  if (!(e instanceof ApiError)) return e?.message || String(e);
  switch (e.code) {
    case 'network': return 'Could not reach the server. Check the address and your connection.';
    case 'invalid_credentials': return 'Wrong username or password.';
    case 'invalid_token': return 'This browser is no longer signed in to Via.';
    case 'rate_limited': return `Too many attempts. Try again in ${e.retryAfter || 'a few'} seconds.`;
    case 'file_too_large': return 'That file is larger than the server allows.';
    case 'quota_exceeded': return 'Your storage quota on the server is full.';
    case 'no_targets': return 'None of the chosen devices can receive this.';
    default: return e.message || `Request failed (${e.status}).`;
  }
}

/** Upload one file as a push, reporting progress (0–1). fetch() can't report upload progress. */
export function uploadFile(cfg, file, to, onProgress) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ filename: file.name, to: to.join(',') });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${cfg.server}/v1/pushes/file?${q}`);
    xhr.setRequestHeader('Authorization', `Bearer ${cfg.token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Could not reach the server'));
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = data?.error ?? {};
      reject(new ApiError(xhr.status, err.code ?? `http_${xhr.status}`, err.message ?? xhr.statusText,
        Number(xhr.getResponseHeader('Retry-After')) || 0));
    };
    xhr.send(file);
  });
}
