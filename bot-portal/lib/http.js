import { HttpError, send, audit, clientIp, readJson, authSide, verifySig, checkFreshNonce, sha } from "./relay.js";

// Wrap a handler: method check, body cap, error mapping, and failure audit.
export const route = (method, action, fn) => async (req, res) => {
  try {
    if (req.method !== method) throw new HttpError(405, "method not allowed");
    const body = method === "POST" ? await readJson(req) : {};
    const auth = await authSide(req, action);
    const out = await fn(auth, body, req);
    return send(res, out?.__status || 200, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status !== 401 && status !== 429) await audit({ action, ok: false, detail: `${status} ${e.message}`.slice(0, 200), ip: clientIp(req) });
    return send(res, status, { error: status === 500 ? "internal error" : e.message });
  }
};

// Signed control actions (rotate, webhook-config): sig over
// "xgb1-<action>|<side>|<ts>|<nonce>|<sha256(JSON.stringify(payload))>"
export async function requireSignedAction(auth, action, body) {
  const { ts, nonce, sig, payload = {} } = body;
  const msg = [`xgb1-${action}`, auth.side, ts, nonce, sha(JSON.stringify(payload))].join("|");
  if (!verifySig(auth.side, msg, sig)) throw new HttpError(403, "bad signature");
  await checkFreshNonce(auth.side, ts, nonce);
  return payload;
}
