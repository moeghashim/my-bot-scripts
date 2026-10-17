#!/usr/bin/env node
// Box-only admin bootstrap. Talks to Upstash directly with KV_REST_API_URL / KV_REST_API_TOKEN
// (from `vercel env pull`, kept outside git). Never deployed.
//   node admin.mjs keygen <outdir>           -> shared AES key + Ed25519 keypair per side
//   node admin.mjs issue <side> [days]       -> prints a new token (stores only its hash)
//   node admin.mjs revoke-all <side>         -> deletes every token for a side
//   node admin.mjs viewer-link <origin>      -> prints a one-time 24h passkey registration link
//   node admin.mjs viewer-reset              -> removes the registered passkey + sessions
import crypto from "node:crypto";
import fs from "node:fs";
const [cmd, a1, a2] = process.argv.slice(2);
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
async function redis(...c) {
  const r = await fetch(process.env.KV_REST_API_URL, { method: "POST", headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, body: JSON.stringify(c) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
async function scanDel(pattern, filter = () => true) {
  let cur = "0", n = 0;
  do { const [nx, keys] = await redis("SCAN", cur, "MATCH", pattern, "COUNT", "200"); cur = nx;
    for (const k of keys) if (await filter(k)) { await redis("DEL", k); n++; } } while (cur !== "0");
  return n;
}
if (cmd === "keygen") {
  fs.mkdirSync(a1, { recursive: true, mode: 0o700 });
  const w = (f, v) => fs.writeFileSync(`${a1}/${f}`, v, { mode: 0o600 });
  w("cross-grokbot-e2e.key", crypto.randomBytes(32).toString("base64url"));
  for (const s of ["personal", "work"]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    w(`cross-grokbot-${s}.sign.key`, privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    w(`cross-grokbot-${s}.sign.pub`, publicKey.export({ type: "spki", format: "der" }).toString("base64"));
  }
  console.log("written to", a1);
} else if (cmd === "issue") {
  const days = Number(a2 || 90);
  const tok = crypto.randomBytes(32).toString("base64url"), hash = sha(tok), exp = Date.now() + days * 86400000;
  await redis("SET", `xgb:tok:${hash}`, JSON.stringify({ side: a1, exp, hash }), "EX", String(Math.max(60, Math.ceil(days * 86400) + 86400)));
  process.stdout.write(tok);
} else if (cmd === "revoke-all") {
  console.log("revoked", await scanDel("xgb:tok:*", async (k) => JSON.parse((await redis("GET", k)) || "{}").side === a1));
} else if (cmd === "viewer-link") {
  const t = crypto.randomBytes(32).toString("base64url");
  await redis("SET", `xgb:viewer:regtoken:${sha(t)}`, "1", "EX", "86400");
  process.stdout.write(`${a1}/viewer#reg=${t}\n`);
} else if (cmd === "viewer-reset") {
  await redis("DEL", "xgb:viewer:cred"); console.log("sessions removed", await scanDel("xgb:viewer:sess:*"));
} else { console.error("see header for usage"); process.exit(1); }
