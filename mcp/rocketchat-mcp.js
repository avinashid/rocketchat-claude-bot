#!/usr/bin/env node
// MCP server exposing the Rocket.Chat API to Claude Code.
//
// Design note: Rocket.Chat has several hundred REST endpoints and no bot needs
// a hand-written wrapper for each. So this server offers two layers:
//
//   1. Named tools for the operations that come up constantly (post a message,
//      list channels, read history, create a channel, invite someone, ...).
//      These exist because a well-named tool with a documented shape is far
//      more reliable than asking a model to remember an endpoint's payload.
//   2. `rocketchat_request`, a generic escape hatch onto ANY endpoint. This is
//      what makes "Claude can do anything on Rocket.Chat" literally true:
//      anything the authenticated account may do over REST is reachable.
//
// The account's own Rocket.Chat permissions are the real boundary here. There
// is no allowlist of endpoints, by design.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { rcFetch, BASE_URL, authHeaders } from "../src/rc.js";

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });

/**
 * Tool table. Each entry: JSON Schema for input, plus a handler returning
 * anything JSON-serialisable.
 */
const TOOLS = [
  {
    name: "rocketchat_request",
    description:
      "Call ANY Rocket.Chat REST endpoint directly. Use this for anything the " +
      "named tools below don't cover — the full API surface is available " +
      "(admin settings, permissions, roles, integrations, livechat, moderation, " +
      "OAuth apps, statistics, imports, video conferences, and so on). " +
      "Paths may be given as 'channels.list' or '/api/v1/channels.list'. " +
      "GET params go in `query`; POST bodies in `body`.",
    schema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE"],
          description: "HTTP method the endpoint expects",
        },
        path: str("Endpoint path, e.g. 'chat.postMessage' or '/api/v1/users.list'"),
        query: {
          type: "object",
          description: "Query-string parameters (mainly for GET)",
          additionalProperties: true,
        },
        body: {
          type: "object",
          description: "JSON request body (for POST/PUT/DELETE)",
          additionalProperties: true,
        },
      },
      required: ["method", "path"],
    },
    handler: ({ method, path: p, query, body }) =>
      rcFetch(method, p, { query, body }),
  },

  // --- Messaging -----------------------------------------------------------
  {
    name: "rocketchat_post_message",
    description:
      "Post a message to a channel, group, or DM. Give either `roomId` or " +
      "`channel` (name with or without '#'). Set `threadId` to reply inside a " +
      "thread. Markdown is supported.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Target room id (preferred when known)"),
        channel: str("Channel name, e.g. '#ai' or 'ai', or '@username' for a DM"),
        text: str("Message body (Rocket.Chat markdown)"),
        threadId: str("Message id to thread this reply under"),
        alias: str("Display name override for this message"),
        emoji: str("Emoji avatar override, e.g. ':robot:'"),
      },
      required: ["text"],
    },
    handler: async ({ roomId, channel, text, threadId, alias, emoji }) => {
      if (!roomId && !channel) throw new Error("Give either roomId or channel");
      const body = { text };
      if (roomId) body.roomId = roomId;
      else body.channel = channel.startsWith("@") || channel.startsWith("#") ? channel : `#${channel}`;
      if (threadId) body.tmid = threadId;
      if (alias) body.alias = alias;
      if (emoji) body.emoji = emoji;
      const res = await rcFetch("POST", "/chat.postMessage", { body });
      return { messageId: res.message?._id, roomId: res.message?.rid, ts: res.message?.ts };
    },
  },
  {
    name: "rocketchat_update_message",
    description: "Edit the text of an existing message.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Room the message is in"),
        msgId: str("Message id to edit"),
        text: str("New message text"),
      },
      required: ["roomId", "msgId", "text"],
    },
    handler: ({ roomId, msgId, text }) =>
      rcFetch("POST", "/chat.update", { body: { roomId, msgId, text } }),
  },
  {
    name: "rocketchat_delete_message",
    description: "Delete a message.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Room the message is in"),
        msgId: str("Message id to delete"),
        asUser: bool("Delete as the calling user rather than as an admin action"),
      },
      required: ["roomId", "msgId"],
    },
    handler: ({ roomId, msgId, asUser }) =>
      rcFetch("POST", "/chat.delete", { body: { roomId, msgId, asUser } }),
  },
  {
    name: "rocketchat_react",
    description: "Add or remove an emoji reaction on a message.",
    schema: {
      type: "object",
      properties: {
        msgId: str("Message id"),
        emoji: str("Emoji including colons, e.g. ':thumbsup:'"),
        shouldReact: bool("true to add (default), false to remove"),
      },
      required: ["msgId", "emoji"],
    },
    handler: ({ msgId, emoji, shouldReact = true }) =>
      rcFetch("POST", "/chat.react", { body: { messageId: msgId, emoji, shouldReact } }),
  },
  {
    name: "rocketchat_pin_message",
    description: "Pin or unpin a message in its room.",
    schema: {
      type: "object",
      properties: {
        msgId: str("Message id"),
        pin: bool("true to pin (default), false to unpin"),
      },
      required: ["msgId"],
    },
    handler: ({ msgId, pin = true }) =>
      rcFetch("POST", pin ? "/chat.pinMessage" : "/chat.unPinMessage", {
        body: { messageId: msgId },
      }),
  },
  {
    name: "rocketchat_read_history",
    description:
      "Read recent messages from a room, newest first. Use this to catch up on " +
      "a conversation before acting on it.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Room id to read"),
        count: num("How many messages to fetch (default 30)"),
        offset: num("Skip this many messages, for paging"),
      },
      required: ["roomId"],
    },
    handler: async ({ roomId, count = 30, offset = 0 }) => {
      const res = await rcFetch("GET", "/chat.getMessages", {
        query: { roomId, count, offset },
      });
      // Trim to the fields that matter — full message objects are enormous and
      // mostly metadata the model has no use for.
      return (res.messages || []).map((m) => ({
        _id: m._id,
        ts: m.ts,
        user: m.u?.username,
        msg: m.msg,
        threadId: m.tmid,
        attachments: m.attachments?.length || 0,
        reactions: m.reactions ? Object.keys(m.reactions) : undefined,
      }));
    },
  },
  {
    name: "rocketchat_search_messages",
    description: "Search messages within a room.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Room id to search in"),
        searchText: str("Text to search for"),
        count: num("Max results (default 20)"),
      },
      required: ["roomId", "searchText"],
    },
    handler: async ({ roomId, searchText, count = 20 }) => {
      const res = await rcFetch("GET", "/chat.search", {
        query: { roomId, searchText, count },
      });
      return (res.messages || []).map((m) => ({
        _id: m._id,
        ts: m.ts,
        user: m.u?.username,
        msg: m.msg,
      }));
    },
  },
  {
    name: "rocketchat_upload_file",
    description:
      "Upload a local file from this machine into a Rocket.Chat room (image, " +
      "log, diff, screenshot, anything). Use it to share work product back to chat.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Target room id"),
        filePath: str("Absolute path of the local file to upload"),
        description: str("Caption shown with the file"),
        threadId: str("Message id to attach this into a thread"),
      },
      required: ["roomId", "filePath"],
    },
    handler: async ({ roomId, filePath, description, threadId }) => {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`No such file: ${abs}`);
      const form = new FormData();
      const bytes = await fs.promises.readFile(abs);
      form.append("file", new Blob([bytes]), path.basename(abs));
      if (description) form.append("description", description);
      if (threadId) form.append("tmid", threadId);
      // Multipart, so this bypasses rcFetch's JSON body handling.
      const response = await fetch(`${BASE_URL}/api/v1/rooms.upload/${roomId}`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.success === false) {
        throw new Error(
          `Upload failed (${response.status}): ${json?.error || "unknown error"}`,
        );
      }
      return { messageId: json?.message?._id, file: path.basename(abs) };
    },
  },

  // --- Rooms ---------------------------------------------------------------
  {
    name: "rocketchat_list_rooms",
    description:
      "List rooms. `scope: 'mine'` (default) lists rooms the bot account is in; " +
      "'all' lists every channel on the workspace (needs admin rights).",
    schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["mine", "all"], description: "Which rooms to list" },
        count: num("Max rooms to return (default 50)"),
      },
    },
    handler: async ({ scope = "mine", count = 50 }) => {
      if (scope === "all") {
        const res = await rcFetch("GET", "/channels.list", { query: { count } });
        return (res.channels || []).map((c) => ({
          _id: c._id,
          name: c.name,
          type: c.t,
          members: c.usersCount,
          topic: c.topic,
        }));
      }
      const res = await rcFetch("GET", "/rooms.get");
      return (res.update || []).slice(0, count).map((r) => ({
        _id: r._id,
        name: r.name || r.fname,
        // t: c=public channel, p=private group, d=direct message, l=livechat
        type: r.t,
        topic: r.topic,
      }));
    },
  },
  {
    name: "rocketchat_room_info",
    description: "Get details about a room by id or name.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Room id"),
        roomName: str("Room name (alternative to roomId)"),
      },
    },
    handler: ({ roomId, roomName }) => {
      if (!roomId && !roomName) throw new Error("Give roomId or roomName");
      return rcFetch("GET", "/rooms.info", {
        query: roomId ? { roomId } : { roomName },
      });
    },
  },
  {
    name: "rocketchat_create_channel",
    description: "Create a channel (public) or private group.",
    schema: {
      type: "object",
      properties: {
        name: str("Channel name, no leading '#'"),
        members: {
          type: "array",
          items: { type: "string" },
          description: "Usernames to add on creation",
        },
        private: bool("true creates a private group instead of a public channel"),
        topic: str("Channel topic to set after creation"),
      },
      required: ["name"],
    },
    handler: async ({ name, members = [], private: isPrivate = false, topic }) => {
      const endpoint = isPrivate ? "/groups.create" : "/channels.create";
      const res = await rcFetch("POST", endpoint, { body: { name, members } });
      const room = res.channel || res.group;
      if (topic && room?._id) {
        await rcFetch("POST", isPrivate ? "/groups.setTopic" : "/channels.setTopic", {
          body: { roomId: room._id, topic },
        });
      }
      return { _id: room?._id, name: room?.name, type: room?.t };
    },
  },
  {
    name: "rocketchat_invite_users",
    description: "Add users to a channel or private group by username.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Target room id"),
        usernames: {
          type: "array",
          items: { type: "string" },
          description: "Usernames to invite",
        },
        private: bool("true if the room is a private group"),
      },
      required: ["roomId", "usernames"],
    },
    handler: async ({ roomId, usernames, private: isPrivate = false }) => {
      const endpoint = isPrivate ? "/groups.invite" : "/channels.invite";
      const results = [];
      for (const username of usernames) {
        // One call per user: channels.invite takes a single userId/username, and
        // reporting per-user outcomes is more useful than failing the whole batch.
        try {
          const who = await rcFetch("GET", "/users.info", { query: { username } });
          await rcFetch("POST", endpoint, { body: { roomId, userId: who.user._id } });
          results.push({ username, invited: true });
        } catch (error) {
          results.push({ username, invited: false, error: error.message });
        }
      }
      return results;
    },
  },
  {
    name: "rocketchat_set_room_attribute",
    description:
      "Set a room's topic, announcement, description, or read-only flag.",
    schema: {
      type: "object",
      properties: {
        roomId: str("Target room id"),
        attribute: {
          type: "string",
          enum: ["topic", "announcement", "description", "readOnly", "name"],
          description: "Which attribute to set",
        },
        value: str("New value ('true'/'false' for readOnly)"),
        private: bool("true if the room is a private group"),
      },
      required: ["roomId", "attribute", "value"],
    },
    handler: ({ roomId, attribute, value, private: isPrivate = false }) => {
      const prefix = isPrivate ? "/groups" : "/channels";
      const endpoint = {
        topic: `${prefix}.setTopic`,
        announcement: `${prefix}.setAnnouncement`,
        description: `${prefix}.setDescription`,
        readOnly: `${prefix}.setReadOnly`,
        name: `${prefix}.rename`,
      }[attribute];
      const key = {
        topic: "topic",
        announcement: "announcement",
        description: "description",
        readOnly: "readOnly",
        name: "name",
      }[attribute];
      const body = { roomId };
      body[key] = attribute === "readOnly" ? value === "true" : value;
      return rcFetch("POST", endpoint, { body });
    },
  },

  // --- Users ---------------------------------------------------------------
  {
    name: "rocketchat_list_users",
    description: "List or search workspace users (needs admin rights).",
    schema: {
      type: "object",
      properties: {
        query: str("Search text matched against username/name/email"),
        count: num("Max users to return (default 50)"),
      },
    },
    handler: async ({ query, count = 50 }) => {
      const q = { count };
      if (query) q.query = JSON.stringify({ $or: [
        { username: { $regex: query, $options: "i" } },
        { name: { $regex: query, $options: "i" } },
      ] });
      const res = await rcFetch("GET", "/users.list", { query: q });
      return (res.users || []).map((u) => ({
        _id: u._id,
        username: u.username,
        name: u.name,
        status: u.status,
        active: u.active,
        roles: u.roles,
      }));
    },
  },
  {
    name: "rocketchat_user_info",
    description: "Look up one user by username or id.",
    schema: {
      type: "object",
      properties: {
        username: str("Username to look up"),
        userId: str("User id to look up"),
      },
    },
    handler: ({ username, userId }) => {
      if (!username && !userId) throw new Error("Give username or userId");
      return rcFetch("GET", "/users.info", {
        query: userId ? { userId } : { username },
      });
    },
  },
  {
    name: "rocketchat_whoami",
    description: "Show which Rocket.Chat account this bot is acting as, and its roles.",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const me = await rcFetch("GET", "/me");
      return {
        _id: me._id,
        username: me.username,
        name: me.name,
        roles: me.roles,
        workspace: BASE_URL,
      };
    },
  },
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

const server = new Server(
  { name: "rocketchat", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return {
      content: [
        { type: "text", text: JSON.stringify(result ?? { success: true }, null, 2) },
      ],
    };
  } catch (error) {
    // Hand the model the failure instead of throwing: it can usually correct
    // course (wrong room id, missing permission) if it can read the reason.
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${error.message}` }],
    };
  }
});

await server.connect(new StdioServerTransport());
