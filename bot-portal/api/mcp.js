// Stateless MCP (Streamable HTTP, JSON responses). Carries ciphertext envelopes only:
// a bot seals with client/relay.mjs, then passes the envelope to relay_send.
import { HttpError, send, readJson, authSide, acceptEnvelope, poll, rooms, audit, clientIp, MARKER } from "../lib/relay.js";

const TOOLS = [
  { name: "relay_send", description: `Send a sealed envelope (from 'node client/relay.mjs seal') to the other side. Plaintext is refused; text starting with "${MARKER}" is never sealed.`,
    inputSchema: { type: "object", properties: { envelope: { type: "object" } }, required: ["envelope"] } },
  { name: "relay_poll", description: "Fetch sealed envelopes for your side since your cursor. Open them with 'node client/relay.mjs open'.",
    inputSchema: { type: "object", properties: { since: { type: "integer" }, limit: { type: "integer" }, peek: { type: "boolean" } } } },
  { name: "relay_rooms", description: "List room slugs with recent traffic.", inputSchema: { type: "object", properties: {} } },
];
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(auth, m) {
  const { id, method, params = {} } = m || {};
  if (id === undefined) return null;
  if (method === "initialize") return ok(id, { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cross-grokbot-relay", version: "2.0.0" }, instructions: `Side: ${auth.side}. Envelopes only.` });
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method !== "tools/call") return rpcErr(id, -32601, "method not found");
  const a = params.arguments || {};
  try {
    let out;
    if (params.name === "relay_send") out = await acceptEnvelope(auth, a.envelope);
    else if (params.name === "relay_poll") out = await poll(auth, a);
    else if (params.name === "relay_rooms") out = { rooms: await rooms() };
    else return rpcErr(id, -32602, "unknown tool");
    return ok(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
  } catch (e) {
    if (e instanceof HttpError) { await audit({ side: auth.side, action: `mcp:${params.name}`, ok: false, detail: `${e.status} ${e.message}`, ip: auth.ip }); return ok(id, { isError: true, content: [{ type: "text", text: e.message }] }); }
    throw e;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "POST JSON-RPC only");
    const body = await readJson(req);
    const auth = await authSide(req, "mcp");
    if (Array.isArray(body)) {
      if (body.length > 10) throw new HttpError(400, "batch too large");
      const out = (await Promise.all(body.map((m) => handle(auth, m)))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202);
    }
    const out = await handle(auth, body);
    return out ? send(res, 200, out) : send(res, 202);
  } catch (e) {
    const s = e instanceof HttpError ? e.status : 500;
    if (s !== 401 && s !== 429) await audit({ action: "mcp", ok: false, detail: `${s} ${e.message}`.slice(0, 200), ip: clientIp(req) });
    return send(res, s, rpcErr(null, -32000, s === 500 ? "internal error" : e.message));
  }
}
