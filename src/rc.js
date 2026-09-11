// Rocket.Chat REST client.
//
// Shared by the bridge (src/index.js) and the MCP server (mcp/rocketchat-mcp.js),
// so both talk to the workspace exactly the same way and there is one place
// where auth headers and error shapes are handled.

const RAW_URL = process.env.RC_URL || "";
if (!RAW_URL) throw new Error("RC_URL is not set");

// Normalise: no trailing slash, so path joining stays predictable.
export const BASE_URL = RAW_URL.replace(/\/+$/, "");
export const AUTH_TOKEN = process.env.RC_AUTH_TOKEN || "";
export const USER_ID = process.env.RC_USER_ID || "";

if (!AUTH_TOKEN || !USER_ID) {
  throw new Error("RC_AUTH_TOKEN and RC_USER_ID must both be set");
}

const TIMEOUT_MS = Number(process.env.RC_HTTP_TIMEOUT_SECONDS || 30) * 1000;

export function authHeaders() {
  return { "X-Auth-Token": AUTH_TOKEN, "X-User-Id": USER_ID };
}

/**
 * Call any Rocket.Chat REST endpoint.
 *
 * This is deliberately generic: `path` is whatever comes after the host, so
 * endpoints this file never heard of still work. That genericity is the whole
 * point of the MCP escape hatch — Rocket.Chat has hundreds of endpoints and
 * hard-coding a wrapper per endpoint would only ever cover a subset.
 *
 * @param {string} method HTTP verb
 * @param {string} path e.g. "/api/v1/chat.postMessage" or "chat.postMessage"
 * @param {{body?: unknown, query?: Record<string, string|number|boolean>}} [opts]
 */
export async function rcFetch(method, path, opts = {}) {
  // Accept "chat.postMessage", "/chat.postMessage" and full "/api/v1/..." forms.
  let p = String(path || "").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.startsWith("/api/")) p = `/api/v1${p}`;

  const url = new URL(BASE_URL + p);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = { ...authHeaders() };
  let body;
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A network-level failure has no HTTP status to report, so name the cause.
    throw new Error(
      error.name === "TimeoutError"
        ? `Rocket.Chat did not answer ${method} ${p} within ${TIMEOUT_MS / 1000}s`
        : `Could not reach Rocket.Chat at ${BASE_URL}: ${error.message}`,
    );
  }

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // some endpoints (file downloads, /api/info edge cases) aren't JSON
  }

  if (!response.ok || (json && json.success === false)) {
    const detail =
      json?.error || json?.message || json?.errorType || text.slice(0, 300) || "no body";
    throw new Error(`Rocket.Chat ${method} ${p} failed (${response.status}): ${detail}`);
  }

  return json ?? { success: true, raw: text };
}

// --- Thin helpers the bridge itself needs ----------------------------------
// Everything else goes through rcFetch / the MCP tools.

export async function whoami() {
  return rcFetch("GET", "/me");
}

/** Post a new message. Returns the created message object. */
export async function postMessage({ roomId, text, threadId, alias }) {
  const payload = { roomId, text };
  if (threadId) payload.tmid = threadId;
  if (alias) payload.alias = alias;
  const res = await rcFetch("POST", "/chat.postMessage", { body: payload });
  return res.message;
}

/** Replace the text of an existing message (used for live-streaming replies). */
export async function updateMessage({ roomId, msgId, text }) {
  const res = await rcFetch("POST", "/chat.update", {
    body: { roomId, msgId, text },
  });
  return res.message;
}

/** React to a message, e.g. emoji ":eyes:". */
export async function react({ msgId, emoji, shouldReact = true }) {
  return rcFetch("POST", "/chat.react", {
    body: { messageId: msgId, emoji, shouldReact },
  });
}

/** Recent messages in a room, oldest-first, for conversational context. */
export async function recentMessages({ roomId, count = 15 }) {
  const res = await rcFetch("GET", "/chat.getMessages", {
    query: { roomId, count, offset: 0 },
  });
  const messages = res.messages || [];
  // chat.getMessages returns newest-first; context reads better oldest-first.
  return messages.slice().reverse();
}
