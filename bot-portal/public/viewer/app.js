// Cross Relay viewer. No third-party code. Decryption happens here; the key never leaves the tab.
const $ = (s) => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

let DATA = null, KEY = null, ROOM = null;
const regToken = new URLSearchParams(location.hash.slice(1)).get("reg");
if (regToken) history.replaceState(null, "", location.pathname); // drop secret from URL bar/history

async function api(op, body) {
  const r = await fetch(`/api/viewer/${op}`, body === undefined ? { credentials: "same-origin" } :
    { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
  return j;
}

async function register() {
  const o = await api("register-options", { regToken });
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: fromB64u(o.challenge), rp: o.rp,
    user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, attestation: "none", timeout: 120000 } });
  const r = cred.response;
  await api("register", { regToken, challenge: o.challenge, id: cred.id, clientDataJSON: b64u(r.clientDataJSON),
    publicKey: b64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm() });
  await load();
}
async function login() {
  const o = await api("login-options", {});
  const a = await navigator.credentials.get({ publicKey: { challenge: fromB64u(o.challenge), rpId: o.rpId,
    allowCredentials: o.allow.map((id) => ({ type: "public-key", id: fromB64u(id) })), userVerification: "required", timeout: 120000 } });
  const r = a.response;
  await api("login", { challenge: o.challenge, id: a.id, clientDataJSON: b64u(r.clientDataJSON),
    authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) });
  await load();
}

async function open(m) {
  const out = { sig: "unchecked" };
  try {
    const pk = DATA.pubkeys[m.from_side];
    if (pk && crypto.subtle) {
      const k = await crypto.subtle.importKey("spki", fromB64u(pk), { name: "Ed25519" }, false, ["verify"]);
      const s = ["xgb1", m.room, m.from_side, m.to_side, m.ts, m.nonce, m.iv, m.ct].join("|");
      out.sig = (await crypto.subtle.verify({ name: "Ed25519" }, k, fromB64u(m.sig), enc.encode(s))) ? "valid" : "INVALID";
    }
  } catch { out.sig = "browser lacks Ed25519 (server verified)"; }
  if (!KEY) return { ...out, locked: true };
  try {
    const aad = enc.encode(["xgb1", m.room, m.from_side, m.to_side, m.ts, m.nonce].join("|"));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(m.iv), additionalData: aad }, KEY, fromB64u(m.ct));
    return { ...out, ...JSON.parse(dec.decode(pt)) };
  } catch { return { ...out, error: "decrypt failed (wrong key?)" }; }
}

async function render() {
  const ul = $("#rooms"); ul.replaceChildren();
  for (const r of DATA.rooms.sort((a, b) => b.last_ts.localeCompare(a.last_ts))) {
    const li = el("li", { textContent: r.room, className: r.room === ROOM ? "sel" : "" });
    li.addEventListener("click", () => { ROOM = r.room; render(); });
    ul.append(li);
  }
  $("#room-title").textContent = ROOM ? `Room: ${ROOM}` : "All rooms";
  const ol = $("#timeline"); ol.replaceChildren();
  for (const m of DATA.messages.filter((m) => !ROOM || m.room === ROOM)) {
    const o = await open(m);
    const body = o.locked ? el("pre", { textContent: "🔒 encrypted — paste key to read" })
      : o.error ? el("pre", { className: "bad", textContent: o.error })
      : el("pre", { textContent: o.text });
    ol.append(el("li", { className: `side-${m.from_side}` },
      el("div", { className: "meta", textContent: `#${m.id} · ${m.from_side} → ${m.to_side} · ${o.from_name ?? "?"} · ${new Date(m.received_at).toLocaleString()} · room ${m.room} · sig ` },
        el("span", { className: o.sig === "valid" ? "good" : o.sig === "INVALID" ? "bad" : "", textContent: o.sig })), body));
  }
  const tb = $("#audit tbody"); tb.replaceChildren();
  for (const a of DATA.audit) tb.append(el("tr", {}, ...[new Date(a.ts).toLocaleString(), a.side ?? "-", a.action, a.ok ? "✓" : "✗", a.detail ?? "", a.ip ?? ""].map((t) => el("td", { textContent: String(t) }))));
}

async function load() {
  $("#auth").hidden = true;
  try { DATA = await api("data"); } catch (e) {
    if (e.status !== 401) { $("#status").textContent = `error: ${e.message}`; return; }
    $("#auth").hidden = false; $("#app").hidden = true; $("#logout").hidden = true;
    $("#register").hidden = !regToken; $("#login").hidden = !!regToken;
    $("#auth-msg").textContent = regToken ? "One-time registration link detected." : "Sign in with your registered passkey.";
    return;
  }
  $("#app").hidden = false; $("#logout").hidden = false; $("#status").textContent = `${DATA.messages.length} messages (7-day retention)`;
  await render();
}

$("#register").addEventListener("click", () => register().catch((e) => ($("#auth-msg").textContent = `Registration failed: ${e.message}`)));
$("#login").addEventListener("click", () => login().catch((e) => ($("#auth-msg").textContent = `Sign-in failed: ${e.message}`)));
$("#logout").addEventListener("click", async () => { await api("logout", {}).catch(() => {}); KEY = null; location.reload(); });
$("#refresh").addEventListener("click", load);
$("#unlock").addEventListener("click", async () => {
  try { KEY = await crypto.subtle.importKey("raw", fromB64u($("#key").value.trim()), "AES-GCM", false, ["decrypt"]); $("#key").value = ""; await render(); }
  catch { $("#status").textContent = "invalid key"; }
});
load();
