#!/usr/bin/env node
// Creates the two Bot Portal databases (Threads + Messages) under an existing Notion page,
// with the exact property names and types lib/notion.js reads and writes. No dependencies, Node 20+.
//
//   NOTION_BOT_PORTAL_TOKEN=... node client/notion-setup.mjs --parent <page id or URL> --bots "Bot A,Bot B,Portal" [--dry-run]
//   (or --token-file <path> instead of the env var; the token is never printed)
//
// --dry-run prints the API requests without calling Notion (no token needed).
// On success it prints the env lines (database + data source ids) to paste into Vercel.
import fs from "node:fs";

const NOTION_VERSION = "2025-09-03";
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes("--dry-run");

export function pageIdFrom(s) {
  const m = String(s || "").replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#].*)?$/i);
  if (!m) throw new Error("--parent must be a Notion page id or URL");
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function botOptions(list) {
  const colors = ["blue", "purple", "orange", "green", "red", "yellow", "pink", "brown", "gray", "default"];
  const names = [...new Set(String(list || "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!names.length) throw new Error("--bots needs at least one bot name");
  if (!names.some((n) => /^portal\b/i.test(n))) names.push("Portal");
  return names.map((name, i) => ({ name, color: colors[i % colors.length] }));
}
const title = (t) => [{ type: "text", text: { content: t } }];

export function threadsBody(parent, bots) {
  return {
    parent: { type: "page_id", page_id: parent }, title: title("Threads"), icon: { type: "emoji", emoji: "🧵" },
    initial_data_source: { properties: {
      "Title": { title: {} },
      "Participants": { multi_select: { options: bots } },
      "Status": { select: { options: [{ name: "Open", color: "green" }, { name: "Closed", color: "gray" }] } },
      "Last sender": { select: { options: bots } },
      "Last message at": { date: {} },
      "Thread ID": { unique_id: { prefix: "BOT" } },
    } },
  };
}
export function messagesBody(parent, bots, threadsDs) {
  return {
    parent: { type: "page_id", page_id: parent }, title: title("Messages"), icon: { type: "emoji", emoji: "✉️" },
    initial_data_source: { properties: {
      "Preview": { title: {} },
      "Body": { rich_text: {} },
      "Sender": { select: { options: bots } },
      // Dual relation: also creates the "Messages" relation property on Threads.
      "Thread": { relation: { data_source_id: threadsDs, type: "dual_property", dual_property: { synced_property_name: "Messages" } } },
      "Sent at": { date: {} },
      "Status": { select: { options: [{ name: "Pending", color: "yellow" }, { name: "Delivered", color: "green" }, { name: "Rejected", color: "red" }] } },
      "Message ID": { unique_id: { prefix: "MSG" } },
    } },
  };
}

export async function setup({ parent, bots, call }) {
  const th = await call("POST", "databases", threadsBody(parent, bots));
  const threadsDs = th.data_sources?.[0]?.id;
  if (!threadsDs) throw new Error("Threads database has no data source in the response");
  const ms = await call("POST", "databases", messagesBody(parent, bots, threadsDs));
  const messagesDs = ms.data_sources?.[0]?.id;
  if (!messagesDs) throw new Error("Messages database has no data source in the response");
  return { THREADS_DB: th.id, THREADS_DS: threadsDs, MESSAGES_DB: ms.id, MESSAGES_DS: messagesDs };
}

async function main() {
  const parent = pageIdFrom(opt("--parent"));
  const bots = botOptions(opt("--bots"));
  let call;
  if (DRY) {
    let n = 0;
    call = async (method, path, body) => {
      console.log(`${method} https://api.notion.com/v1/${path}\n${JSON.stringify(body, null, 2)}\n`);
      n++; return { id: `dry-run-database-${n}`, data_sources: [{ id: `dry-run-data-source-${n}` }] };
    };
  } else {
    const tf = opt("--token-file");
    const token = (tf ? fs.readFileSync(tf, "utf8") : process.env.NOTION_BOT_PORTAL_TOKEN || "").trim();
    if (!token) throw new Error("set NOTION_BOT_PORTAL_TOKEN or pass --token-file");
    call = async (method, path, body) => {
      const r = await fetch(`https://api.notion.com/v1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Notion ${r.status} ${j.code || ""}: ${j.message || ""}${r.status === 404 ? " (is the parent page shared with the integration?)" : ""}`);
      return j;
    };
  }
  const ids = await setup({ parent, bots, call });
  console.log(`# Paste into Vercel env (not secrets, but keep them out of public repos):
BOT_PORTAL_THREADS_DB=${ids.THREADS_DB}
BOT_PORTAL_THREADS_DS=${ids.THREADS_DS}
BOT_PORTAL_MESSAGES_DB=${ids.MESSAGES_DB}
BOT_PORTAL_MESSAGES_DS=${ids.MESSAGES_DS}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
