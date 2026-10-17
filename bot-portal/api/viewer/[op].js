// Passkey-gated viewer API. One WebAuthn credential max, registered via a
// one-time link. Session cookie: __Host-, HttpOnly, Secure, SameSite=Strict.
import crypto from "node:crypto";
import { HttpError, send, readJson, redis, K, sha, b64u, audit, clientIp, listInbox, rooms, SIDES } from "../../lib/relay.js";

// Set VIEWER_ORIGIN to your deployment origin, e.g. https://your-relay.vercel.app
const ORIGIN = process.env.VIEWER_ORIGIN || "https://relay.example.com";
const VIEWER_USER = process.env.VIEWER_USER || "owner";
const RP_ID = new URL(ORIGIN).hostname;
const SESSION_TTL = 8 * 3600;
const COOKIE = "__Host-xgb_s";

const fromB64u = (s) => Buffer.from(String(s || ""), "base64url");

async function newChallenge(purpose) {
  const c = b64u(crypto.randomBytes(32));
  await redis("SET", K("viewer", "chal", c), purpose, "EX", "300");
  return c;
}
async function useChallenge(c, purpose) {
  const v = await redis("GETDEL", K("viewer", "chal", String(c || "x")));
  if (v !== purpose) throw new HttpError(400, "bad or expired challenge");
}
function checkClientData(cdjB64u, type, challenge) {
  let cd; try { cd = JSON.parse(fromB64u(cdjB64u).toString("utf8")); } catch { throw new HttpError(400, "bad clientData"); }
  if (cd.type !== type) throw new HttpError(400, "wrong ceremony type");
  if (cd.challenge !== challenge) throw new HttpError(400, "challenge mismatch");
  if (cd.origin !== ORIGIN) throw new HttpError(400, "origin mismatch");
  if (cd.crossOrigin) throw new HttpError(400, "cross-origin ceremony");
}
async function startSession(res) {
  const s = b64u(crypto.randomBytes(32));
  await redis("SET", K("viewer", "sess", sha(s)), "1", "EX", String(SESSION_TTL));
  res.setHeader("Set-Cookie", `${COOKIE}=${s}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`);
}
function cookie(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|; )${COOKIE.replace(/[-]/g, "\\-")}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}
async function requireSession(req) {
  const s = cookie(req);
  if (!s || !(await redis("GET", K("viewer", "sess", sha(s))))) throw new HttpError(401, "no session");
}
function sameOrigin(req) {
  // Defence in depth on top of SameSite=Strict for state-changing POSTs.
  if (req.headers.origin !== ORIGIN) throw new HttpError(403, "bad origin");
}

const ops = {
  async "register-options"(req, b) {
    sameOrigin(req);
    if (await redis("GET", K("viewer", "cred"))) throw new HttpError(409, "a passkey is already registered");
    if (!(await redis("GET", K("viewer", "regtoken", sha(String(b.regToken || "")))))) throw new HttpError(403, "invalid or used registration link");
    return { challenge: await newChallenge("reg"), rp: { id: RP_ID, name: "Cross Relay Viewer" }, user: { id: b64u(Buffer.from(VIEWER_USER)), name: VIEWER_USER, displayName: VIEWER_USER } };
  },
  async register(req, b, res) {
    sameOrigin(req);
    await useChallenge(b.challenge, "reg");
    const rt = K("viewer", "regtoken", sha(String(b.regToken || "")));
    if (!(await redis("GETDEL", rt))) throw new HttpError(403, "invalid or used registration link");
    checkClientData(b.clientDataJSON, "webauthn.create", b.challenge);
    if (![-7, -8, -257].includes(b.alg)) throw new HttpError(400, "unsupported alg");
    crypto.createPublicKey({ key: fromB64u(b.publicKey), format: "der", type: "spki" }); // validates
    const cred = { id: String(b.id), spki: String(b.publicKey), alg: b.alg, counter: 0, created: new Date().toISOString() };
    const set = await redis("SET", K("viewer", "cred"), JSON.stringify(cred), "NX");
    if (set !== "OK") throw new HttpError(409, "a passkey is already registered");
    await startSession(res);
    return { ok: true };
  },
  async "login-options"(req) {
    sameOrigin(req);
    const c = await redis("GET", K("viewer", "cred"));
    if (!c) throw new HttpError(404, "no passkey registered yet");
    return { challenge: await newChallenge("login"), rpId: RP_ID, allow: [JSON.parse(c).id] };
  },
  async login(req, b, res) {
    sameOrigin(req);
    await useChallenge(b.challenge, "login");
    const cred = JSON.parse((await redis("GET", K("viewer", "cred"))) || "null");
    if (!cred || b.id !== cred.id) throw new HttpError(403, "unknown credential");
    checkClientData(b.clientDataJSON, "webauthn.get", b.challenge);
    const ad = fromB64u(b.authenticatorData);
    if (ad.length < 37) throw new HttpError(400, "bad authenticatorData");
    if (!ad.subarray(0, 32).equals(crypto.createHash("sha256").update(RP_ID).digest())) throw new HttpError(400, "rpId mismatch");
    const flags = ad[32];
    if (!(flags & 1) || !(flags & 4)) throw new HttpError(403, "user presence/verification required");
    const data = Buffer.concat([ad, crypto.createHash("sha256").update(fromB64u(b.clientDataJSON)).digest()]);
    const key = crypto.createPublicKey({ key: fromB64u(cred.spki), format: "der", type: "spki" });
    const ok = crypto.verify(cred.alg === -8 ? null : "sha256", data, key, fromB64u(b.signature));
    if (!ok) throw new HttpError(403, "bad passkey signature");
    const counter = ad.readUInt32BE(33);
    if (counter !== 0 && counter <= cred.counter) throw new HttpError(403, "signature counter did not increase (cloned key?)");
    await redis("SET", K("viewer", "cred"), JSON.stringify({ ...cred, counter }));
    await startSession(res);
    return { ok: true };
  },
  async logout(req, b, res) {
    sameOrigin(req);
    const s = cookie(req);
    if (s) await redis("DEL", K("viewer", "sess", sha(s)));
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  },
  async data(req) {
    await requireSession(req);
    const [r, ...inboxes] = await Promise.all([rooms(), ...SIDES.map((s) => listInbox(s, 0, 200))]);
    const msgs = inboxes.flat().sort((a, b) => a.received_at.localeCompare(b.received_at));
    const raw = (await redis("ZREVRANGE", K("audit"), "0", "199")) || [];
    return { rooms: r, messages: msgs, audit: raw.map((x) => JSON.parse(x)), pubkeys: Object.fromEntries(SIDES.map((s) => [s, process.env[`RELAY_PUBKEY_${s.toUpperCase()}`] || null])) };
  },
};
const PUBLIC_GET = new Set(["data"]);

export default async function handler(req, res) {
  const op = String(req.query?.op || "");
  try {
    const fn = ops[op];
    if (!fn) throw new HttpError(404, "not found");
    const wantGet = PUBLIC_GET.has(op);
    if (req.method !== (wantGet ? "GET" : "POST")) throw new HttpError(405, "method not allowed");
    const ip = clientIp(req);
    const n = await redis("INCR", K("rl", "viewer", ip));
    if (n === 1) await redis("EXPIRE", K("rl", "viewer", ip), "60");
    if (n > 60) throw new HttpError(429, "rate limited");
    const body = wantGet ? {} : await readJson(req);
    const out = await fn(req, body, res);
    if (op !== "data") await audit({ side: "viewer", action: `viewer:${op}`, ok: true, ip });
    return send(res, 200, out);
  } catch (e) {
    const s = e instanceof HttpError ? e.status : 500;
    await audit({ side: "viewer", action: `viewer:${op}`, ok: false, detail: `${s} ${e.message}`.slice(0, 200), ip: clientIp(req) });
    return send(res, s, { error: s === 500 ? "internal error" : e.message });
  }
}
