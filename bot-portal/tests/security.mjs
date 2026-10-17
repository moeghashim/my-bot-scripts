#!/usr/bin/env node
// End-to-end + security tests against the live relay.
//   node tests/security.mjs <personal.env> <work.env>
// Needs KV creds in env (for issuing a throwaway expired token). Rotates the personal token
// and rewrites <personal.env> with the new one.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { seal, open } from "../client/relay.mjs";

const load = (f) => Object.fromEntries(fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const [pf, wf] = process.argv.slice(2);
let P = load(pf); const W = load(wf); const B = P.RELAY_URL;
let pass = 0, fail = 0;
const t = (name, cond, info = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`); };
async function post(path, token, body, raw) {
  const h = { "Content-Type": "application/json" }; if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + path, { method: "POST", headers: h, body: raw ?? JSON.stringify(body ?? {}) });
  return { status: r.status, j: await r.json().catch(() => ({})), h: r.headers };
}
const signed = (c, action, payload) => {
  const ts = new Date().toISOString(), nonce = crypto.randomBytes(18).toString("base64url");
  const hsh = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const key = crypto.createPrivateKey({ key: Buffer.from(c.RELAY_SIGN_KEY, "base64"), format: "der", type: "pkcs8" });
  return { ts, nonce, payload, sig: crypto.sign(null, Buffer.from([`xgb1-${action}`, c.RELAY_SIDE, ts, nonce, hsh].join("|")), key).toString("base64url") };
};

// drain
await post("/api/poll", P.RELAY_TOKEN); await post("/api/poll", W.RELAY_TOKEN);

console.log("-- functional");
let r = await post("/api/send", P.RELAY_TOKEN, { envelope: seal(P, { room: "sec-test", from_name: "Alice", text: "secret hello from personal" }) });
t("personal send accepted", r.status === 200 && r.j.delivered_to === "work", JSON.stringify(r.j));
r = await post("/api/poll", W.RELAY_TOKEN);
const got = r.j.messages?.map((m) => open(W, m)) || [];
t("work polls + decrypts + verifies", got.length === 1 && got[0].text === "secret hello from personal" && got[0].display.startsWith("↪ [personal · Alice]"), got[0]?.display);
t("server stored ciphertext only", !JSON.stringify(r.j).includes("secret hello") && !JSON.stringify(r.j).includes("Alice"));
r = await post("/api/send", W.RELAY_TOKEN, { envelope: seal(W, { room: "sec-test", from_name: "WorkBot", text: "reply from work", reply_to: got[0]?.id }) });
t("work send accepted", r.status === 200 && r.j.delivered_to === "personal");
r = await post("/api/poll", P.RELAY_TOKEN);
const gp = r.j.messages?.map((m) => open(P, m)) || [];
t("personal polls + decrypts reply", gp.length === 1 && gp[0].text === "reply from work" && gp[0].from_side === "work");
r = await post("/mcp", P.RELAY_TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/list" });
t("MCP tools/list works", r.j.result?.tools?.length === 3);

console.log("-- auth");
r = await post("/api/poll", null); t("no token rejected", r.status === 401);
r = await post("/api/poll", "A".repeat(43)); t("unknown token rejected", r.status === 401);
r = await post("/mcp", null, { jsonrpc: "2.0", id: 1, method: "tools/list" }); t("MCP no token rejected", r.status === 401);
const env = seal(P, { room: "sec-test", from_name: "x", text: "spoof" });
r = await post("/api/send", W.RELAY_TOKEN, { envelope: env }); t("wrong-side token (work token, personal envelope) rejected", r.status === 403, r.j.error);
const forged = seal({ ...P, RELAY_SIGN_KEY: W.RELAY_SIGN_KEY }, { room: "sec-test", from_name: "x", text: "forged" });
r = await post("/api/send", P.RELAY_TOKEN, { envelope: forged }); t("envelope signed with other side's key rejected", r.status === 403, r.j.error);
const tam = seal(P, { room: "sec-test", from_name: "x", text: "tamper" }); tam.room = "other-room";
r = await post("/api/send", P.RELAY_TOKEN, { envelope: tam }); t("tampered envelope (room changed) rejected", r.status === 403, r.j.error);
const expired = execFileSync("node", [new URL("../client/admin.mjs", import.meta.url).pathname, "issue", "personal", "-1"]).toString();
r = await post("/api/poll", expired); t("expired token rejected", r.status === 401);

console.log("-- replay / freshness");
const once = seal(P, { room: "sec-test", from_name: "Alice", text: "only once" });
r = await post("/api/send", P.RELAY_TOKEN, { envelope: once }); t("fresh envelope accepted", r.status === 200);
r = await post("/api/send", P.RELAY_TOKEN, { envelope: once }); t("replayed envelope rejected", r.status === 409, r.j.error);
const old = seal(P, { room: "sec-test", from_name: "x", text: "old" });
// re-sign with a stale timestamp
{ const key = crypto.createPrivateKey({ key: Buffer.from(P.RELAY_SIGN_KEY, "base64"), format: "der", type: "pkcs8" });
  old.ts = new Date(Date.now() - 10 * 60000).toISOString();
  old.sig = crypto.sign(null, Buffer.from(["xgb1", old.room, old.from_side, old.to_side, old.ts, old.nonce, old.iv, old.ct].join("|")), key).toString("base64url"); }
r = await post("/api/send", P.RELAY_TOKEN, { envelope: old }); t("stale timestamp (10 min) rejected", r.status === 400, r.j.error);

console.log("-- limits / guards");
r = await post("/api/send", P.RELAY_TOKEN, null, JSON.stringify({ pad: "x".repeat(40 * 1024) })); t("oversize body (40 KB) rejected", r.status === 413);
r = await post("/api/webhook-config", P.RELAY_TOKEN, signed(P, "webhook-config", { url: "https://httpbin.org/post", headers: {} })); t("disallowed webhook host rejected", r.status === 400, r.j.error);
r = await post("/api/webhook-config", P.RELAY_TOKEN, signed(P, "webhook-config", { url: "http://api.cursor.com/x" })); t("non-https webhook rejected", r.status === 400);
r = await post("/api/webhook-config", P.RELAY_TOKEN, { ts: new Date().toISOString(), nonce: "n".repeat(20), sig: "AAAA", payload: { url: null } }); t("unsigned webhook-config rejected", r.status === 403);
let threw = false; try { seal(P, { room: "sec-test", from_name: "Router", text: "↪ [work · WorkBot] reply from work" }); } catch { threw = true; }
t("loop guard: client refuses to seal relayed text", threw);
const lp = seal(P, { room: "sec-test", from_name: "Router", text: "x" }); lp.loop = true;
r = await post("/api/send", P.RELAY_TOKEN, { envelope: lp }); t("loop guard: server refuses loop-flagged envelope", r.status >= 400, r.j.error);

console.log("-- viewer");
r = await fetch(B + "/api/viewer/data"); t("viewer data without session rejected", r.status === 401);
r = await fetch(B + "/api/viewer/data", { headers: { Cookie: "__Host-xgb_s=" + "A".repeat(43) } }); t("viewer data with forged session rejected", r.status === 401);
r = await post("/api/viewer/register-options", null, { regToken: "nope" }); t("viewer register without same-origin rejected", r.status === 403);
r = await fetch(B + "/api/viewer/register-options", { method: "POST", headers: { Origin: B, "Content-Type": "application/json" }, body: JSON.stringify({ regToken: "bogus-token" }) });
t("viewer register with bad link rejected", r.status === 403);

console.log("-- headers");
const hv = await fetch(B + "/viewer"); const csp = hv.headers.get("content-security-policy") || "";
t("viewer CSP strict", csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"));
t("HSTS + nosniff + DENY", !!hv.headers.get("strict-transport-security") && hv.headers.get("x-content-type-options") === "nosniff" && hv.headers.get("x-frame-options") === "DENY");
const ha = await post("/api/poll", null); t("API responses carry CSP + no-store", !!ha.h.get("content-security-policy") && (ha.h.get("cache-control") || "").includes("no-store"));

console.log("-- rotation");
r = await post("/api/rotate", P.RELAY_TOKEN, signed(P, "rotate", {}));
t("rotate issues new token", r.status === 200 && !!r.j.token, r.j.expires_at);
if (r.j.token) {
  const nt = r.j.token;
  const ok = await post("/api/poll", nt); t("new token works", ok.status === 200);
  fs.writeFileSync(pf, fs.readFileSync(pf, "utf8").replace(/^RELAY_TOKEN=.*$/m, `RELAY_TOKEN=${nt}`), { mode: 0o600 });
  P = load(pf);
}

console.log("-- rate limit (work side, 60/min)");
let limited = false; for (let i = 0; i < 70 && !limited; i++) { const x = await post("/api/rooms", W.RELAY_TOKEN); if (x.status === 429) limited = true; }
t("per-side rate limit enforced", limited);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
