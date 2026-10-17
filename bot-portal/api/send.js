import { route } from "../lib/http.js";
import { acceptEnvelope } from "../lib/relay.js";
export default route("POST", "send", (auth, body) => acceptEnvelope(auth, body.envelope));
