import { route } from "../lib/http.js";
import { rooms } from "../lib/relay.js";
export default route("POST", "rooms", async () => ({ rooms: await rooms() }));
