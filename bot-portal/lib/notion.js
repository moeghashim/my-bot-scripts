// Notion "Bot Portal" webhook receiver helpers.
// Design: one Notion integration connected ONLY to the Bot Portal page, which holds two databases:
//   Threads  (Title, Participants, Status, Last sender, Last message at, Thread ID, Messages<->)
//   Messages (Preview, Body, Sender, Thread->Threads, Sent at, Status Pending/Delivered/Rejected, Message ID)
// A new Messages row = a new message. We route it to the thread's participants (minus sender).
import crypto from "node:crypto";
import { redis, K, HttpError, getWebhook, hostAllowed } from "./relay.js";

export const NOTION_VERSION = "2025-09-03";
const norm = (id) => String(id || "").replace(/-/g, "").toLowerCase();
// Notion IDs come only from env (no hardcoded fallbacks). Unset IDs never match.
export const MESSAGES_DS = norm(process.env.BOT_PORTAL_MESSAGES_DS);
export const MESSAGES_DB = norm(process.env.BOT_PORTAL_MESSAGES_DB);
export const THREADS_DS = norm(process.env.BOT_PORTAL_THREADS_DS);
export const THREADS_DB = norm(process.env.BOT_PORTAL_THREADS_DB);

export function verifySignature(raw, header, token) {
  if (!token || typeof header !== "string") return false;
  const calc = "sha256=" + crypto.createHmac("sha256", token).update(raw).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function notion(path, init = {}) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.NOTION_BOT_PORTAL_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new HttpError(502, `notion ${r.status}`);
  return r.json();
}

const inDs = (page, ds, db) => { const p = page?.parent || {}; return (!!ds && norm(p.data_source_id) === ds) || (!!db && norm(p.database_id) === db); };
export const isMessage = (pg) => inDs(pg, MESSAGES_DS, MESSAGES_DB);
export const isThread = (pg) => inDs(pg, THREADS_DS, THREADS_DB);
const plain = (rt) => (rt || []).map((t) => t.plain_text || "").join("");

export function readMessage(pg) {
  const p = pg.properties || {};
  return {
    sender: p.Sender?.select?.name || null,
    body: plain(p.Body?.rich_text) || plain(p.Preview?.title),
    preview: plain(p.Preview?.title),
    threadIds: (p.Thread?.relation || []).map((r) => r.id),
    status: p.Status?.select?.name || null,
    sentAt: p["Sent at"]?.date?.start || pg.created_time,
    msgId: p["Message ID"]?.unique_id ? `${p["Message ID"].unique_id.prefix || ""}-${p["Message ID"].unique_id.number}` : null,
  };
}

// Each side has exactly one Portal routine. Personal Portal: BOT_PORTAL_WEBHOOK_URL/AUTH env.
// Work Portal: the webhook registered for side "work" via /api/webhook-config (xgb:webhook:work).
// Bots named in WORK_BOTS (comma-separated) route to Work Portal; everything else to personal Portal.
// Example default; set WORK_BOTS to your own work-side bot names.
const WORK_BOTS_DEFAULT = "Work Bot,Work Portal,Portal (Work)";
export const workBots = () => String(process.env.WORK_BOTS || WORK_BOTS_DEFAULT).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const sideOf = (bot) => (workBots().includes(String(bot || "").trim().toLowerCase()) ? "work" : "personal");
export function splitBySide(to) {
  const g = { personal: [], work: [] };
  for (const b of to) g[sideOf(b)].push(b);
  return g;
}
export function portalRoute() {
  const url = process.env.BOT_PORTAL_WEBHOOK_URL, auth = process.env.BOT_PORTAL_WEBHOOK_AUTH;
  return url ? { url, headers: auth ? { Authorization: auth } : {} } : null;
}
export async function routeFor(side) {
  if (side === "personal") return portalRoute();
  const w = await getWebhook("work").catch(() => null);
  if (!w || !hostAllowed(w.url)) return null;
  return { url: w.url, headers: w.headers || {} };
}

async function setStatus(pageId, status) {
  try { await notion(`pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties: { Status: { select: { name: status } } } }) }); } catch { /* best effort */ }
}

export async function handleEvent(evt) {
  const t = evt?.type || "";
  if (t !== "page.created" && t !== "page.properties_updated") return { ignored: "type" };
  const pageId = evt.entity?.id;
  if (!pageId) return { ignored: "no page" };
  const pg = await notion(`pages/${pageId}`);
  if (!isMessage(pg)) return { ignored: "not a Messages row" };
  const m = readMessage(pg);
  // Only route rows that are new (no status) or explicitly Pending; our own Delivered/Rejected writes stop here.
  if (m.status && m.status !== "Pending") return { ignored: `status ${m.status}` };
  if (!m.sender || !m.body || m.threadIds.length !== 1) return { ignored: "incomplete (waiting for Sender/Body/Thread)" };
  // Route each message exactly once, ever.
  if ((await redis("SET", K("notion", "routed", norm(pageId)), "1", "NX", "EX", String(60 * 60 * 24 * 30))) !== "OK") return { ignored: "already routed" };

  const th = await notion(`pages/${m.threadIds[0]}`);
  if (!isThread(th)) { await setStatus(pageId, "Rejected"); return { rejected: "thread not in Threads DB" }; }
  const tp = th.properties || {};
  const participants = (tp.Participants?.multi_select || []).map((o) => o.name);
  if (tp.Status?.select?.name === "Closed") { await setStatus(pageId, "Rejected"); return { rejected: "thread closed" }; }
  if (!participants.includes(m.sender)) { await setStatus(pageId, "Rejected"); return { rejected: "sender not participant" }; }

  const threadId = tp["Thread ID"]?.unique_id ? `${tp["Thread ID"].unique_id.prefix || ""}-${tp["Thread ID"].unique_id.number}` : null;
  const payload = { kind: "bot-portal-message", message_id: m.msgId, message_page_id: pageId, message_url: pg.url, thread_id: threadId, thread_page_id: th.id, title: plain(tp.Title?.title), participants, sender: m.sender, sent_at: m.sentAt, text: m.body.slice(0, 8000) };
  const to = participants.filter((p) => p !== m.sender);
  const out = [];
  if (!to.length) out.push({ skipped: "no recipients" });
  for (const [side, group] of Object.entries(splitBySide(to))) {
    if (!group.length) continue;
    const r = await routeFor(side);
    if (!r) { out.push({ side, to: group, skipped: `no ${side} portal route` }); continue; }
    let res = null, err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rr = await fetch(r.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", ...r.headers }, body: JSON.stringify({ ...payload, to: group, all_to: to, side, from_portal: m.sender === "Portal" }) });
        res = rr.status; err = null;
        if (rr.ok) break;
      } catch (e) { err = String(e.message || e).slice(0, 100); res = null; }
      if (attempt === 0) await new Promise((ok) => setTimeout(ok, 1500));
    }
    out.push(err ? { side, to: group, error: err } : { side, to: group, status: res });
  }
  const okDelivery = (o) => o.status >= 200 && o.status < 300;
  if (out.length && out.every(okDelivery)) await setStatus(pageId, "Delivered");
  else {
    // Delivery failed after a retry (or had no route): don't leave the row Pending forever.
    // Clear the routed key so re-setting Status to Pending re-routes it, and mark it Rejected.
    await redis("DEL", K("notion", "routed", norm(pageId))).catch(() => {});
    await setStatus(pageId, "Rejected");
  }
  try {
    await notion(`pages/${th.id}`, { method: "PATCH", body: JSON.stringify({ properties: { "Last sender": { select: { name: m.sender } }, "Last message at": { date: { start: m.sentAt } } } }) });
  } catch { /* best effort */ }
  return { message: pageId, forwarded: out };
}
