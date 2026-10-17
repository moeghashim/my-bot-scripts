// Rotate your token: returns a new 90-day token; the old one keeps working for 1 hour.
import { route, requireSignedAction } from "../lib/http.js";
import { issueToken, redis, K, audit } from "../lib/relay.js";
export default route("POST", "rotate", async (auth, body) => {
  await requireSignedAction(auth, "rotate", body);
  const fresh = await issueToken(auth.side);
  const grace = Math.min(auth.exp, Date.now() + 3600_000);
  await redis("SET", K("tok", auth.tokenHash), JSON.stringify({ side: auth.side, exp: grace, hash: auth.tokenHash }), "EX", "7200");
  await audit({ side: auth.side, action: "rotate", ok: true, detail: `new exp ${fresh.expires_at}`, ip: auth.ip });
  return { ...fresh, old_token_valid_until: new Date(grace).toISOString() };
});
