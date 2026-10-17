import { route } from "../lib/http.js";
import { poll } from "../lib/relay.js";
export default route("POST", "poll", (auth, b) => poll(auth, { since: b.since, limit: b.limit, peek: b.peek }));
