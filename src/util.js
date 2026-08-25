// Small shared helpers: HTTP with timeout/retry, number coercion, and a concurrency limiter.

const DEFAULT_TIMEOUT_MS = 12000;

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${new Date().toISOString()}]`, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + JSON with a hard timeout and bounded retries. Retries on network errors,
 * 429 and 5xx; honours Retry-After when the server sends one.
 */
export async function fetchJson(url, options = {}) {
  const { retries = 2, timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });

      if (res.status === 429 || res.status >= 500) {
        // Novig reports Retry-After in milliseconds; Kalshi uses seconds. Treat small
        // values as seconds and large ones as milliseconds, then clamp.
        const raw = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(raw) && raw > 0 ? (raw < 100 ? raw * 1000 : raw) : 400 * 2 ** attempt;
        lastErr = new Error(`HTTP ${res.status} from ${url}`);
        if (attempt < retries) {
          await sleep(Math.min(waitMs, 5000));
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Coerce Kalshi's dollar/fixed-point strings (and anything else) to a finite number or null. */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Run tasks with a bounded number in flight, preserving input order in the result. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Round to `dp` decimal places, returning a number (not a string). */
export function round(value, dp = 2) {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Decimal odds and American odds for a probability-style price, for display only. */
export function toAmerican(price) {
  if (!(price > 0 && price < 1)) return null;
  const dec = 1 / price;
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

export function formatAmerican(price) {
  const a = toAmerican(price);
  if (a === null) return '—';
  return a > 0 ? `+${a}` : `${a}`;
}
