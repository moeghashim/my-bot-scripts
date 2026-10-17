#!/usr/bin/env node
// Cross Relay client: E2E seal/open + signed HTTP calls. Zero dependencies (Node >= 20).
//
// Config: env vars, or --config <file> with KEY=VALUE lines (keep it chmod 600, outside git):
//   RELAY_URL         https://your-relay.vercel.app
//   RELAY_SIDE        personal | work
//   RELAY_TOKEN       bearer token for this side
//   RELAY_E2E_KEY     shared 32-byte AES-256-GCM key, base64url (same on both sides)
//   RELAY_SIGN_KEY    this side's Ed25519 private key, PKCS8 DER base64
//   RELAY_PEER_PUBKEY other side's Ed25519 public key, SPKI DER base64
//
// Commands:
//   send --room <slug> --from <name> (--text <t> | --stdin) [--reply-to <id>]
//   poll [--since N] [--peek]       -> decrypted, signature-verified JSON
//   rooms
//   seal --room ... --from ... --text ...   -> envelope JSON (for MCP relay_send)
//   open < envelopes.json                   -> decrypted JSON (for MCP relay_poll output)
//   webhook --url <https url> --header Name:Value   |  webhook --clear
//   rotate                                   -> prints new token (save it yourself)
import crypto from "node:crypto";
import fs from "node:fs";

export const MARKER = "↪";
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(`--${n}`);

function loadConfig() {
  const c = { ...process.env };
  const f = opt("config") || process.env.RELAY_CONFIG;
  if (f) for (const line of fs.readFileSync(f, "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) c[m[1]] = m[2]; }
  for (const k of ["RELAY_URL", "RELAY_SIDE", "RELAY_TOKEN"]) if (!c[k]) throw new Error(`missing ${k}`);
  return c;
}
const other = (s) => (s === "personal" ? "work" : "personal");
const b64u = (b) => Buffer.from(b).toString("base64url");
const aesKey = (c) => { const k = Buffer.from(c.RELAY_E2E_KEY || "", "base64url"); if (k.length !== 32) throw new Error("RELAY_E2E_KEY must be 32 bytes base64url"); return k; };
const signKey = (c) => crypto.createPrivateKey({ key: Buffer.from(c.RELAY_SIGN_KEY, "base64"), format: "der", type: "pkcs8" });
const peerKey = (c) => crypto.createPublicKey({ key: Buffer.from(c.RELAY_PEER_PUBKEY, "base64"), format: "der", type: "spki" });

export function seal(c, { room, from_name, text, reply_to = null }) {
  if (String(text).trimStart().startsWith(MARKER)) throw new Error(`loop guard: refusing to relay text that starts with ${MARKER} (it was already relayed)`);
  const e = { v: 1, room, from_side: c.RELAY_SIDE, to_side: other(c.RELAY_SIDE), ts: new Date().toISOString(), nonce: b64u(crypto.randomBytes(18)) };
  const iv = crypto.randomBytes(12);
  const ci = crypto.createCipheriv("aes-256-gcm", aesKey(c), iv);
  ci.setAAD(Buffer.from(["xgb1", e.room, e.from_side, e.to_side, e.ts, e.nonce].join("|")));
  const ct = Buffer.concat([ci.update(JSON.stringify({ text, from_name, reply_to }), "utf8"), ci.final(), ci.getAuthTag()]);
  e.iv = b64u(iv); e.ct = b64u(ct);
  e.sig = b64u(crypto.sign(null, Buffer.from(["xgb1", e.room, e.from_side, e.to_side, e.ts, e.nonce, e.iv, e.ct].join("|")), signKey(c)));
  return e;
}
export function open(c, m) {
  const sigOk = crypto.verify(null, Buffer.from(["xgb1", m.room, m.from_side, m.to_side, m.ts, m.nonce, m.iv, m.ct].join("|")), peerKey(c), Buffer.from(m.sig, "base64url"));
  if (!sigOk || m.from_side !== other(c.RELAY_SIDE)) return { id: m.id, room: m.room, error: "signature check failed: dropped" };
  const raw = Buffer.from(m.ct, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey(c), Buffer.from(m.iv, "base64url"));
  d.setAAD(Buffer.from(["xgb1", m.room, m.from_side, m.to_side, m.ts, m.nonce].join("|")));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const pt = JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8"));
  return { id: m.id, room: m.room, from_side: m.from_side, from_name: pt.from_name, text: pt.text, reply_to: pt.reply_to, ts: m.ts,
    display: `${MARKER} [${m.from_side} · ${pt.from_name}] ${pt.text}` };
}
function signedAction(c, action, payload) {
  const ts = new Date().toISOString(), nonce = b64u(crypto.randomBytes(18));
  const h = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const sig = b64u(crypto.sign(null, Buffer.from([`xgb1-${action}`, c.RELAY_SIDE, ts, nonce, h].join("|")), signKey(c)));
  return { ts, nonce, sig, payload };
}
async function call(c, path, body) {
  const r = await fetch(`${c.RELAY_URL}${path}`, { method: "POST", headers: { Authorization: `Bearer ${c.RELAY_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`${r.status} ${j.error || ""}`); e.status = r.status; throw e; }
  return j;
}
const readStdin = () => fs.readFileSync(0, "utf8");

async function main() {
  const c = loadConfig();
  const text = flag("stdin") ? readStdin() : opt("text");
  const rt = opt("reply-to") ? Number(opt("reply-to")) : null;
  let out;
  switch (cmd) {
    case "seal": out = seal(c, { room: opt("room"), from_name: opt("from"), text, reply_to: rt }); break;
    case "send": out = await call(c, "/api/send", { envelope: seal(c, { room: opt("room"), from_name: opt("from"), text, reply_to: rt }) }); break;
    case "poll": {
      const r = await call(c, "/api/poll", { since: opt("since") ? Number(opt("since")) : undefined, peek: flag("peek") });
      out = { cursor: r.cursor, count: r.count, messages: r.messages.map((m) => open(c, m)) }; break;
    }
    case "open": { const j = JSON.parse(readStdin()); const list = Array.isArray(j) ? j : j.messages || [j]; out = list.map((m) => open(c, m)); break; }
    case "rooms": out = await call(c, "/api/rooms"); break;
    case "webhook": {
      const hdr = opt("header"); const headers = {};
      if (hdr) { const i = hdr.indexOf(":"); headers[hdr.slice(0, i).trim()] = hdr.slice(i + 1).trim(); }
      out = await call(c, "/api/webhook-config", signedAction(c, "webhook-config", flag("clear") ? { url: null } : { url: opt("url"), headers })); break;
    }
    case "rotate": out = await call(c, "/api/rotate", signedAction(c, "rotate", {})); break;
    default: throw new Error("usage: relay.mjs send|poll|rooms|seal|open|webhook|rotate [--config file] ...");
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
