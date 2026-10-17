import { send, audit, redis, K, HttpError } from "../lib/relay.js";
import { verifySignature, handleEvent } from "../lib/notion.js";

const MAX = 64 * 1024;
async function raw(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) throw new HttpError(413, "too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  try {
    const body = await raw(req);
    let evt; try { evt = JSON.parse(body); } catch { return send(res, 400, { error: "json" }); }

    // Setup is locked: once NOTION_WEBHOOK_VERIFICATION_TOKEN is configured, refuse new
    // verification tokens. Before that, only the first token is stored (SET NX), never overwritten.
    if (evt && typeof evt.verification_token === "string" && Object.keys(evt).length === 1) {
      if (process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN) {
        await audit({ kind: "notion.verification_refused" });
        return send(res, 409, { error: "already configured" });
      }
      const set = await redis("SET", K("notion", "pending_verification_token"), evt.verification_token, "NX", "EX", String(60 * 60 * 24));
      if (set !== "OK") return send(res, 409, { error: "already pending" });
      await audit({ kind: "notion.verification_received" });
      return send(res, 200, { ok: true });
    }

    const token = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
    if (!token) return send(res, 503, { error: "not configured" });
    if (!verifySignature(body, req.headers["x-notion-signature"], token)) {
      await audit({ kind: "notion.bad_signature" });
      return send(res, 401, { error: "signature" });
    }
    const result = await handleEvent(evt);
    await audit({ kind: "notion.event", type: evt.type, event_id: evt.id, ...result });
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, e.status || 500, { error: e.status ? e.message : "internal" });
  }
}
