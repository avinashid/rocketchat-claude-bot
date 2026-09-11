// Credential smoke test: confirms the token works and reports what it can do.
// `pnpm whoami` before starting the bot tells you whether auth is the problem.

import { whoami, rcFetch, BASE_URL } from "./rc.js";

const me = await whoami();
console.log(`workspace: ${BASE_URL}`);
console.log(`account:   @${me.username} (${me._id})`);
console.log(`name:      ${me.name || "(unset)"}`);
console.log(`roles:     ${(me.roles || []).join(", ") || "(none)"}`);

const admin = (me.roles || []).includes("admin");
console.log(`admin:     ${admin ? "yes — full workspace control" : "no — channel-scoped only"}`);

try {
  const rooms = await rcFetch("GET", "/rooms.get");
  const list = rooms.update || [];
  console.log(`rooms:     ${list.length} subscribed`);
  for (const room of list.slice(0, 15)) {
    const kind = { c: "channel", p: "private", d: "dm", l: "livechat" }[room.t] || room.t;
    console.log(`  - ${room.name || room.fname || room._id} (${kind}, ${room._id})`);
  }
} catch (error) {
  console.log(`rooms:     could not list — ${error.message}`);
}
