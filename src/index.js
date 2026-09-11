// Rocket.Chat <-> Claude Code bridge.
//
// Listens to every message in the rooms the bot account can see, decides which
// ones are actually meant for it, and answers those with a real Claude Code run
// that can act on this host and on the Rocket.Chat workspace itself.
//
// Access control fails CLOSED. Answering somebody here hands them a pipe into
// Claude Code, which can run commands on this machine, so with no allowlist
// configured the bot answers nobody.

import { RocketChatRealtime } from "./ddp.js";
import { whoami, postMessage, rcFetch } from "./rc.js";
import {
  ask,
  shouldRespond,
  resetSession,
  sessionIdFor,
  usageFor,
  runtimeInfo,
} from "./claude-code.js";
import { LiveReply } from "./live-reply.js";
import { mentionsMe as addressesMe, stripMention as stripAddress } from "./mention.js";

const RC_URL = process.env.RC_URL;

function csv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const ALLOWED_USERS = new Set(csv("BOT_ALLOWED_USERNAMES").map((u) => u.replace(/^@/, "")));
const ADMIN_USERS = new Set(csv("BOT_ADMIN_USERNAMES").map((u) => u.replace(/^@/, "")));

// Room filter: names or ids. `*` means every room the bot account is in.
const ROOM_RULE = csv("BOT_ALLOWED_ROOMS").map((r) => r.replace(/^#/, ""));
const ALL_ROOMS = ROOM_RULE.includes("*");
const ALLOWED_ROOMS = new Set(ROOM_RULE.filter((r) => r !== "*"));

// When true, non-addressed messages go through the triage model. When false the
// bot only ever answers direct mentions and DMs.
const LISTEN_ALWAYS = process.env.BOT_LISTEN_ALWAYS !== "false";
const SHOW_COST = process.env.BOT_SHOW_COST === "true";
const CONTEXT_SIZE = Number(process.env.BOT_CONTEXT_MESSAGES || 12);

let me = null;
// Rooms currently switched into the admin profile. In memory only, so a restart
// drops every room back to the sandboxed profile.
const adminRooms = new Set();
// Rolling per-room transcript, so triage and the first turn of a session have
// some idea what the channel was talking about.
const history = new Map();

// Channel context includes messages from people who are NOT allowed to drive
// the bot — that's what makes it useful context, and also what makes it an
// injection surface. So each line records whether its author is trusted, and
// untrusted ones are labelled where the model can see it.
function remember(roomId, author, text, { trusted }) {
  const lines = history.get(roomId) ?? [];
  lines.push(trusted ? `${author}: ${text}` : `${author} [not authorised]: ${text}`);
  while (lines.length > CONTEXT_SIZE) lines.shift();
  history.set(roomId, lines);
}

function contextFor(roomId) {
  return (history.get(roomId) ?? []).join("\n");
}

// Neither the room's name nor its type is on the message payload, so look them
// up once and keep them.
const rooms = new Map();

// Message ids already handled.
//
// The stream re-broadcasts a message whenever its document changes, and the
// bot itself changes it: acknowledging with a :eyes: reaction rewrites the
// source message, which comes straight back down the same subscription. That
// second delivery has no `editedAt` and looks identical to a new message, so
// without this the bot answers everything twice.
const handled = new Set();
const HANDLED_CAP = 500;

function alreadyHandled(msgId) {
  if (handled.has(msgId)) return true;
  handled.add(msgId);
  // Bounded, oldest-first: a Set iterates in insertion order.
  if (handled.size > HANDLED_CAP) {
    for (const id of handled) {
      handled.delete(id);
      if (handled.size <= HANDLED_CAP) break;
    }
  }
  return false;
}

async function roomInfoFor(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  // Fall back to the id as the name, and to the guess below for the type, if
  // the lookup fails.
  let info = { name: roomId, direct: looksDirect(roomId) };
  try {
    const res = await rcFetch("GET", "/rooms.info", { query: { roomId } });
    const room = res.room || {};
    const direct = room.t === "d";
    info = {
      name: room.name || room.fname || (direct ? "direct message" : roomId),
      direct,
    };
  } catch {
    // A room we can't introspect is still a room we can answer in.
  }
  rooms.set(roomId, info);
  return info;
}

// Last-resort DM check, for when rooms.info can't be reached. Some
// Rocket.Chat versions build a DM room id by concatenating both user ids, so
// the bot's own id appears inside it — but others use an opaque hash, and then
// this says "not a DM" about a DM. `t === "d"` from rooms.info is the real
// answer; this is only the fallback.
function looksDirect(roomId) {
  return me?._id ? roomId.includes(me._id) : false;
}

function roomAllowed(roomId, room) {
  if (room.direct) return true;
  if (ALL_ROOMS) return true;
  return ALLOWED_ROOMS.has(roomId) || ALLOWED_ROOMS.has(room.name);
}

// --- Commands --------------------------------------------------------------
// `!`-prefixed so they don't collide with Rocket.Chat's own `/` slash commands.

async function handleCommand({ roomId, author, command, argument }) {
  const isAdminUser = ADMIN_USERS.has(author);
  switch (command) {
    case "reset": {
      const profile = adminRooms.has(roomId) ? "admin" : "normal";
      resetSession(roomId, profile);
      history.delete(roomId);
      return `Session cleared. Next message starts fresh (${profile} profile).`;
    }
    case "usage": {
      const profile = adminRooms.has(roomId) ? "admin" : "normal";
      const stats = usageFor(roomId, profile);
      if (!stats) return "No usage recorded for this room yet.";
      return [
        `**Usage for this room** (${profile})`,
        `messages: ${stats.messages}`,
        `turns: ${stats.turns}`,
        `cost: $${stats.cost.toFixed(4)}`,
        `since: ${stats.since}`,
      ].join("\n");
    }
    case "info": {
      const info = runtimeInfo();
      const profile = adminRooms.has(roomId) ? "admin" : "normal";
      return [
        `**${me.username}** on ${RC_URL}`,
        `profile: ${profile}`,
        `session: ${sessionIdFor(roomId, profile) ? "active" : "none"}`,
        `workspace: \`${info.workspace}\``,
        `permission mode: ${info.permissionMode}`,
        `model: ${info.model} (triage: ${info.triageModel})`,
        `listening to every message: ${LISTEN_ALWAYS}`,
        `timeout: ${info.timeoutSeconds}s`,
      ].join("\n");
    }
    case "admin": {
      if (!isAdminUser) return ":no_entry: You're not on the admin allowlist.";
      if (argument === "off") {
        adminRooms.delete(roomId);
        return "Back to the sandboxed workspace profile.";
      }
      adminRooms.add(roomId);
      return [
        ":unlock: **Admin profile on for this room.**",
        "Full host access, permissions bypassed. `!admin off` to leave.",
      ].join("\n");
    }
    case "help":
      return [
        `**${me.username}** — Claude Code in Rocket.Chat`,
        "",
        "Just talk normally: I read the channel and answer when something looks",
        `like it's for me. @${me.username} to be certain, or DM me.`,
        "",
        "`!reset` — forget this room's conversation",
        "`!usage` — turns and cost for this room",
        "`!info` — how I'm configured",
        "`!admin` / `!admin off` — wide-scope host access (allowlisted users)",
        "`!help` — this",
      ].join("\n");
    default:
      return null;
  }
}

// --- Message handling ------------------------------------------------------

async function onMessage(message) {
  const roomId = message.rid;
  const author = message.u?.username;
  const text = message.msg || "";

  // Never react to our own output, to other bots, or to system events like
  // "user added" — those all arrive on the same stream.
  if (!roomId || !author) return;
  if (message.u?._id === me._id) return;
  if (message.bot) return;
  if (message.t) return; // system message (join/leave/topic change/...)
  if (message.editedAt) return; // an edit, not a new message
  if (alreadyHandled(message._id)) return; // re-broadcast of one we've seen

  const room = await roomInfoFor(roomId);
  const roomName = room.name;
  if (!roomAllowed(roomId, room)) return;

  // Every message in an allowed room becomes context, whether or not we answer.
  remember(roomId, author, text, { trusted: ALLOWED_USERS.has(author) });

  if (!ALLOWED_USERS.has(author)) {
    // Silently ignored: a channel full of "you're not allowed" replies is worse
    // than saying nothing, and the allowlist is deliberately the hard boundary.
    if (addressesMe(message, me)) {
      console.log(`ignoring @mention from non-allowlisted user ${author}`);
    }
    return;
  }

  const addressed = addressesMe(message, me) || room.direct;
  const body = addressed ? stripAddress(text, me) : text;

  // Commands first — cheap, and they must work even when triage would say no.
  const commandMatch = body.match(/^!(\w+)\s*(.*)$/);
  if (commandMatch) {
    const reply = await handleCommand({
      roomId,
      author,
      command: commandMatch[1].toLowerCase(),
      argument: commandMatch[2].trim(),
    });
    if (reply) {
      await postMessage({ roomId, text: reply, threadId: message.tmid });
      return;
    }
  }

  if (!body.trim() && !message.attachments?.length) {
    // A bare "@claude" with nothing after it is a ping, not a request: there is
    // no prompt to run, but going silent makes the bot look broken. Say
    // something instead.
    if (addressed) {
      await postMessage({
        roomId,
        text: `I'm here — what do you need? \`!help\` lists what I can do.`,
        threadId: message.tmid,
      });
    }
    return;
  }

  // Not addressed to us: ask the cheap model whether this is our business.
  if (!addressed) {
    if (!LISTEN_ALWAYS) return;
    const wanted = await shouldRespond({
      botName: me.username,
      context: contextFor(roomId),
      message: text,
      author,
    });
    if (!wanted) return;
    console.log(`triage said yes for ${author} in ${roomName}`);
  }

  const profile = adminRooms.has(roomId) && ADMIN_USERS.has(author) ? "admin" : "normal";
  const live = new LiveReply({
    roomId,
    threadId: message.tmid,
    sourceMsgId: message._id,
  });

  try {
    await live.start();
  } catch (error) {
    console.error(`could not post placeholder in ${roomName}: ${error.message}`);
    return;
  }

  try {
    const result = await ask(
      {
        roomId,
        roomName,
        author,
        botName: me.username,
        text: body,
        context: contextFor(roomId),
        profile,
      },
      {
        onText: (delta) => live.onText(delta),
        onTool: (name) => live.onTool(name),
      },
    );

    const suffix = SHOW_COST
      ? `\n\n_${result.turns} turn(s) · $${result.cost.toFixed(4)}_`
      : "";
    await live.finish(result.text + suffix);
    remember(roomId, me.username, result.text.slice(0, 400), { trusted: true });
  } catch (error) {
    console.error(`run failed in ${roomName}: ${error.message}`);
    await live.fail(error.message.slice(0, 900)).catch(() => {});
  }
}

// --- Startup ---------------------------------------------------------------

async function main() {
  if (!ALLOWED_USERS.size) {
    console.warn(
      "BOT_ALLOWED_USERNAMES is empty — the bot will answer nobody. " +
        "Add your Rocket.Chat username to .env to enable it.",
    );
  }

  me = await whoami();
  console.log(
    `authenticated as @${me.username} (${me._id}) on ${RC_URL}; roles: ${(me.roles || []).join(", ")}`,
  );
  console.log(
    `allowlist: ${[...ALLOWED_USERS].join(", ") || "(nobody)"} | ` +
      `rooms: ${ALL_ROOMS ? "all" : [...ALLOWED_ROOMS].join(", ") || "(dms only)"} | ` +
      `admin: ${[...ADMIN_USERS].join(", ") || "(nobody)"}`,
  );

  const realtime = new RocketChatRealtime({
    url: RC_URL,
    authToken: process.env.RC_AUTH_TOKEN,
  });

  realtime.on("ready", () => console.log("realtime stream subscribed"));
  realtime.on("disconnected", () => console.warn("realtime disconnected"));
  realtime.on("warn", (m) => console.warn(`realtime: ${m}`));
  realtime.on("error", (error) => console.error(`realtime error: ${error.message}`));
  realtime.on("message", (message) => {
    // Never let one bad message take the process down; pm2 restarting the bot
    // mid-conversation is worse than logging and moving on.
    onMessage(message).catch((error) =>
      console.error(`handler threw: ${error.stack || error.message}`),
    );
  });

  realtime.connect();

  const shutdown = () => {
    console.log("shutting down");
    realtime.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
