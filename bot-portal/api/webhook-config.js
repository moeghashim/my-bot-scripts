import { route, requireSignedAction } from "../lib/http.js";
import { setWebhook, audit } from "../lib/relay.js";
export default route("POST", "webhook-config", async (auth, body) => {
  const p = await requireSignedAction(auth, "webhook-config", body);
  const out = await setWebhook(auth, p);
  await audit({ side: auth.side, action: "webhook-config", ok: true, detail: out.cleared ? "cleared" : `host=${out.url_host}`, ip: auth.ip });
  return out;
});
