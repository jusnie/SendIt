// Finding links in text. Notes stay notes on the wire; these only make the URLs in them
// clickable, and tell a link apart from text when sending.

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;

/** The http(s) URLs in `text`, without trailing punctuation like "see https://x.com." */
export function findLinks(text) {
  const out = [];
  for (const m of (text ?? '').matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (isWebUrl(url)) out.push({ url, start: m.index, end: m.index + url.length });
  }
  return out;
}

/** The single URL in `text`, or null when it has none or several. */
export function singleLink(text) {
  const links = findLinks(text);
  return links.length === 1 ? links[0].url : null;
}

/** True when `text` is just one URL that starts with http(s):// or www. Strict on purpose:
 * it suggests sending text as a link, and "notes.txt" shouldn't count. */
export function looksLikeLink(text) {
  const t = (text ?? '').trim();
  return /^(https?:\/\/|www\.)\S+$/i.test(t) && isLinkInput(t);
}

/** True when `text` is a web address someone typed, scheme optional ("example.com/a"). */
export function isLinkInput(text) {
  const t = (text ?? '').trim();
  if (!t || /\s/.test(t)) return false;
  // Another scheme (mailto:, javascript:), but not a port ("localhost:3000").
  if (!/^https?:\/\//i.test(t) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return false;
  const url = normalizeLink(t);
  if (!isWebUrl(url)) return false;
  const u = new URL(url);
  if (u.username || u.password) return false;
  return (u.hostname.includes('.') && !u.hostname.endsWith('.')) || u.hostname === 'localhost' || u.hostname.startsWith('[');
}

/** Adds https:// when there's no scheme. */
export function normalizeLink(text) {
  const t = text.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function isWebUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Appends `text` to `el`, with its URLs as links handled by `onOpen(url)`. */
export function appendLinkified(el, text, onOpen) {
  let at = 0;
  for (const { url, start, end } of findLinks(text)) {
    el.append(text.slice(at, start));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onOpen(url); };
    el.append(a);
    at = end;
  }
  el.append(text.slice(at));
}

function trimUrl(url) {
  // Punctuation that ends a sentence, and a ")" that closes a parenthesis around the URL.
  for (;;) {
    const last = url.at(-1);
    if ('.,;:!?\'"*'.includes(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
    else if (last === ']' && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
    else return url;
  }
}

function count(s, ch) {
  return s.split(ch).length - 1;
}
