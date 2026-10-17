import assert from "node:assert";
import { pageIdFrom, botOptions, threadsBody, messagesBody, setup } from "../client/notion-setup.mjs";
assert.equal(pageIdFrom("https://www.notion.so/Bot-Portal-0123456789abcdef0123456789abcdef"), "01234567-89ab-cdef-0123-456789abcdef");
assert.equal(pageIdFrom("01234567-89ab-cdef-0123-456789abcdef"), "01234567-89ab-cdef-0123-456789abcdef");
assert.throws(() => pageIdFrom("nope"));
const bots = botOptions("Bot A, Bot B, Bot A");
assert.deepEqual(bots.map((b) => b.name), ["Bot A", "Bot B", "Portal"]);
// Property names/types must match what lib/notion.js reads and writes.
const t = threadsBody("p", bots).initial_data_source.properties, m = messagesBody("p", bots, "ds-t").initial_data_source.properties;
assert(t.Title.title && t.Participants.multi_select && t.Status.select && t["Last sender"].select && t["Last message at"].date && t["Thread ID"].unique_id);
assert(m.Preview.title && m.Body.rich_text && m.Sender.select && m["Sent at"].date && m.Status.select && m["Message ID"].unique_id);
assert.deepEqual(m.Status.select.options.map((o) => o.name), ["Pending", "Delivered", "Rejected"]);
assert.deepEqual(t.Status.select.options.map((o) => o.name), ["Open", "Closed"]);
assert.equal(m.Thread.relation.data_source_id, "ds-t"); assert.equal(m.Thread.relation.dual_property.synced_property_name, "Messages");
const calls = [];
const ids = await setup({ parent: "p", bots, call: async (meth, path, body) => { calls.push(body.title[0].text.content); return { id: `db${calls.length}`, data_sources: [{ id: `ds${calls.length}` }] }; } });
assert.deepEqual(calls, ["Threads", "Messages"]);
assert.deepEqual(ids, { THREADS_DB: "db1", THREADS_DS: "ds1", MESSAGES_DB: "db2", MESSAGES_DS: "ds2" });
console.log("notion-setup tests ok");
