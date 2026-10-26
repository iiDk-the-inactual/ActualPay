// Tiny DOM and fetch helpers shared by the dashboard and the hosted pay page.
// Everything is built with createElement/textContent, never HTML strings, so API
// data can never become markup (there is a test that enforces this).

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected')
      node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let csrfToken = null;
export function setCsrf(token) {
  csrfToken = token;
}

/** JSON request with the session cookie and CSRF header. Throws ApiError. */
export async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server.');
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON error */
  }
  if (!response.ok) {
    const err = data && typeof data === 'object' ? data.error : null;
    throw new ApiError(
      response.status,
      err && typeof err.code === 'string' ? err.code : 'ERROR',
      err && typeof err.message === 'string' ? err.message : `Request failed (${response.status}).`,
    );
  }
  return data;
}

export function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function fmtMoney(m) {
  if (!m || typeof m !== 'object') return '';
  return `${m.amount} ${String(m.asset).toUpperCase()}`;
}

const GOOD = new Set(['paid', 'confirmed', 'active', 'delivered', 'approved']);
const BAD = new Set([
  'expired',
  'failed',
  'cancelled',
  'rejected',
  'reversed',
  'disabled',
  'needs_review',
]);
export function badge(status) {
  const s = String(status);
  return el('span', {
    class: `badge ${GOOD.has(s) ? 'good' : BAD.has(s) ? 'bad' : 'warn'}`,
    text: s.replaceAll('_', ' '),
  });
}
