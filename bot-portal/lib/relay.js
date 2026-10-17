// Core relay: token auth (hashed, expiring, rotatable), rate limits, body cap,
// Ed25519 signature + timestamp/nonce replay checks, ciphertext-only storage
// with 7-day TTL, 30-day audit log, webhook wake restricted to an allowlist.
import crypto from "node:crypto";

export const SIDES = ["personal", "work"];
export const other = (s) => (s === "personal" ? "work" : "personal");
export const MARKER = "↪";
export const MAX_BODY = 32 * 1024;
const MSG_TTL = 7 * 86400;
const AUDIT_TTL = 30 * 86400;
const SKEW_MS = 5 * 60 * 1000;
const RATE_PER_MIN = 60;
export const TOKEN_TTL_DAYS = 90;

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
export const b64u = (buf) => Buffer.from(buf).toString("base64url");

// ---------- redis (Upstash REST) ----------
export async function redis(...cmd) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(`redis: ${j.error}`);
  return j.result;
}
export const K = (...p) => ["xgb", ...p].join(":");

// ---------- request helpers ----------
export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 45) || "unknown";
}
export async function readJson(req) {
  const len = Number(req.headers["content-length"] || 0);
  if (len > MAX_BODY) throw new HttpError(413, "body too large");
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new HttpError(413, "body too large"); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
}
export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(obj === undefined ? "" : JSON.stringify(obj));
}

// ---------- audit ----------
export async function audit(entry) {
  const e = { ts: new Date().toISOString(), ...entry };
  const now = Date.now();
  try {
    await redis("ZADD", K("audit"), String(now), JSON.stringify({ ...e, r: crypto.randomBytes(4).toString("hex") }));
    await redis("ZREMRANGEBYSCORE", K("audit"), "-inf", String(now - AUDIT_TTL * 1000));
    await redis("EXPIRE", K("audit"), String(AUDIT_TTL));
  } catch { /* audit must never break the request */ }
}

// ---------- rate limiting ----------
async function bump(key, limit, windowSec) {
  const n = await redis("INCR", key);
  if (n === 1) await redis("EXPIRE", key, String(windowSec));
  return n <= limit;
}

// ---------- auth ----------
// Tokens live in Redis as xgb:tok:<sha256> -> {side, exp}. Plaintext is never stored.
export async function authSide(req, action) {
  const ip = clientIp(req);
  if (!(await bump(K("rl", "ip", ip), 120, 60))) {
    await audit({ action, ok: false, detail: "ip rate limited", ip });
    throw new HttpError(429, "rate limited");
  }
  const h = String(req.headers["authorization"] || "");
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const fail = async (detail) => {
    await bump(K("rl", "authfail", ip), 1e9, 600);
    await audit({ action, ok: false, detail, ip });
    return new HttpError(401, "unauthorized");
  };
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(tok)) throw await fail("missing/malformed token");
  const fails = Number((await redis("GET", K("rl", "authfail", ip))) || 0);
  if (fails > 20) { await audit({ action, ok: false, detail: "auth lockout", ip }); throw new HttpError(429, "too many failed auth attempts"); }
  const hash = sha(tok);
  const rec = await redis("GET", K("tok", hash));
  if (!rec) throw await fail("unknown token");
  const { side, exp, hash: stored } = JSON.parse(rec);
  // constant-time compare of the stored hash against the computed one
  if (!stored || !crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(hash, "hex"))) throw await fail("token hash mismatch");
  if (!SIDES.includes(side)) throw await fail("bad token record");
  if (Date.now() > exp) throw await fail(`expired token (${side})`);
  if (!(await bump(K("rl", "side", side, String(Math.floor(Date.now() / 60000))), RATE_PER_MIN, 120))) {
    await audit({ side, action, ok: false, detail: "side rate limited", ip });
    throw new HttpError(429, "rate limited");
  }
  return { side, ip, tokenHash: hash, exp };
}

export async function issueToken(side, days = TOKEN_TTL_DAYS) {
  const tok = b64u(crypto.randomBytes(32));
  const hash = sha(tok);
  const exp = Date.now() + days * 86400000;
  await redis("SET", K("tok", hash), JSON.stringify({ side, exp, hash }), "EX", String(days * 86400 + 86400));
  return { token: tok, side, expires_at: new Date(exp).toISOString() };
}

// ---------- signatures & replay ----------
function pubKey(side) {
  const b = process.env[`RELAY_PUBKEY_${side.toUpperCase()}`];
  if (!b) throw new HttpError(500, `no public key configured for ${side}`);
  return crypto.createPublicKey({ key: Buffer.from(b, "base64"), format: "der", type: "spki" });
}
export function verifySig(side, data, sigB64u) {
  try { return crypto.verify(null, Buffer.from(data), pubKey(side), Buffer.from(String(sigB64u), "base64url")); }
  catch (e) { if (e instanceof HttpError) throw e; return false; }
}
export async function checkFreshNonce(side, ts, nonce) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce || ""))) throw new HttpError(400, "bad nonce");
  const t = Date.parse(ts);
  if (!t || Math.abs(Date.now() - t) > SKEW_MS) throw new HttpError(400, "timestamp outside ±5 min window");
  const fresh = await redis("SET", K("nonce", side, nonce), "1", "NX", "EX", String(2 * SKEW_MS / 1000));
  if (fresh !== "OK") throw new HttpError(409, "replay: nonce already used");
}

// Envelope produced by client/relay.mjs. Everything the server needs for routing
// is in clear (room slug, sides, ts, nonce); text/from_name live inside ct.
export const sigString = (e) => ["xgb1", e.room, e.from_side, e.to_side, e.ts, e.nonce, e.iv, e.ct].join("|");

export async function acceptEnvelope(auth, env) {
  const e = env || {};
  const room = String(e.room || "");
  if (!/^[a-z0-9._:-]{1,64}$/.test(room)) throw new HttpError(400, "bad room slug");
  if (e.v !== 1) throw new HttpError(400, "unsupported envelope version");
  if (e.from_side !== auth.side) throw new HttpError(403, `wrong side: token is ${auth.side}, envelope claims ${e.from_side}`);
  if (e.to_side !== other(auth.side)) throw new HttpError(400, "to_side must be the other side");
  if (!/^[A-Za-z0-9_-]{16}$/.test(e.iv || "") || !/^[A-Za-z0-9_-]{24,16000}$/.test(e.ct || "")) throw new HttpError(400, "bad iv/ct");
  if (!verifySig(auth.side, sigString(e), e.sig)) throw new HttpError(403, "bad signature");
  // loop guard: the client sets loop=true when the plaintext starts with the relay marker
  // (server can't see plaintext); clients refuse to seal such text, and we refuse the flag.
  if (e.loop) throw new HttpError(409, "loop guard: relayed text cannot be re-relayed");
  await checkFreshNonce(auth.side, e.ts, e.nonce);

  const to = e.to_side;
  const id = await redis("INCR", K("seq", to));
  const stored = { id, v: 1, room, from_side: e.from_side, to_side: to, ts: e.ts, nonce: e.nonce, iv: e.iv, ct: e.ct, sig: e.sig, received_at: new Date().toISOString() };
  await redis("SET", K("msg", to, String(id)), JSON.stringify(stored), "EX", String(MSG_TTL));
  await redis("ZADD", K("inbox", to), String(id), String(id));
  await redis("EXPIRE", K("inbox", to), String(MSG_TTL));
  await redis("HSET", K("rooms"), room, JSON.stringify({ last_ts: stored.received_at, last_from: auth.side }));
  await redis("EXPIRE", K("rooms"), String(MSG_TTL));
  const wake = await wakeSide(to, { room, id, from_side: auth.side }).catch((x) => `error: ${x.message}`);
  await audit({ side: auth.side, action: "send", ok: true, detail: `room=${room} id=${id} wake=${wake}`, ip: auth.ip });
  return { ok: true, id, delivered_to: to, room, wake };
}

export async function listInbox(side, since = 0, limit = 200) {
  const ids = (await redis("ZRANGEBYSCORE", K("inbox", side), `(${Number(since) || 0}`, "+inf", "LIMIT", "0", String(Math.min(limit, 200)))) || [];
  if (!ids.length) return [];
  const vals = await redis("MGET", ...ids.map((i) => K("msg", side, i)));
  const dead = ids.filter((_, i) => !vals[i]);
  if (dead.length) await redis("ZREM", K("inbox", side), ...dead);
  return vals.filter(Boolean).map((v) => JSON.parse(v));
}

export async function poll(auth, { since, limit = 50, peek = false } = {}) {
  const cursorKey = K("cursor", auth.side);
  const cur = Number.isInteger(since) ? since : Number((await redis("GET", cursorKey)) || 0);
  const msgs = await listInbox(auth.side, cur, limit);
  const last = msgs.length ? msgs[msgs.length - 1].id : cur;
  if (!peek && msgs.length) await redis("SET", cursorKey, String(last));
  await audit({ side: auth.side, action: "poll", ok: true, detail: `since=${cur} count=${msgs.length}`, ip: auth.ip });
  return { side: auth.side, since: cur, cursor: last, count: msgs.length, messages: msgs };
}

export async function rooms() {
  const h = (await redis("HGETALL", K("rooms"))) || [];
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push({ room: h[i], ...JSON.parse(h[i + 1]) });
  return out;
}

// ---------- webhook wake ----------
// Only hosts in WEBHOOK_HOST_ALLOWLIST (comma-separated; "*.example.com" allowed) may be targets.
// Grok Bot routine webhooks (personal and Work Portal) are always allowed.
export const DEFAULT_WEBHOOK_HOSTS = ["api2.cursor.sh"];
export function hostAllowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const allow = [...DEFAULT_WEBHOOK_HOSTS, ...String(process.env.WEBHOOK_HOST_ALLOWLIST || "").split(",")].map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = u.hostname.toLowerCase();
  return allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a));
}
export async function setWebhook(auth, { url, headers }) {
  if (url == null) { await redis("DEL", K("webhook", auth.side)); return { ok: true, cleared: true }; }
  if (!hostAllowed(url)) throw new HttpError(400, "webhook host not in allowlist");
  const hdrs = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 512) throw new HttpError(400, "bad header");
    hdrs[k] = v;
  }
  await redis("SET", K("webhook", auth.side), JSON.stringify({ url, headers: hdrs }));
  return { ok: true, side: auth.side, url_host: new URL(url).host };
}
export async function getWebhook(side) {
  const cfg = await redis("GET", K("webhook", side));
  return cfg ? JSON.parse(cfg) : null;
}
async function wakeSide(side, meta) {
  const cfg = await redis("GET", K("webhook", side));
  if (!cfg) return "none (receiver polls)";
  const { url, headers } = JSON.parse(cfg);
  if (!hostAllowed(url)) return "blocked (host no longer allowlisted)";
  // Only metadata goes out — never ciphertext or plaintext.
  const r = await fetch(url, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ source: "cross-grokbot-relay", event: "relay_message", ...meta }),
    signal: AbortSignal.timeout(5000),
  });
  return `webhook ${r.status}`;
}
