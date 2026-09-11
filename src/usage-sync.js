// Mirrors .rc-usage.json into a single Rocket.Chat message so the Claude Usage
// app can read it through the local REST API (the app sandbox cannot reach the
// host network). Deterministic file read + chat.update; never calls Claude.
import { readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';

const {
  RC_URL,
  RC_AUTH_TOKEN,
  RC_USER_ID,
  USAGE_FILE = '/home/ubuntu/projects/rocketchat-claude-workspace/.rc-usage.json',
  USAGE_ROOM_ID,
  USAGE_MSG_ID,
} = process.env;

const MAX_ROOMS = 40;
const POLL_MS = 60_000;

const rc = async (path, body) => {
  const res = await fetch(`${RC_URL}/api/v1/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-auth-token': RC_AUTH_TOKEN,
      'x-user-id': RC_USER_ID,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${path}: ${json.error || res.status}`);
  return json;
};

// Claude Code plan limits (5-hour session window + weekly) as reported by the
// subscription's OAuth usage endpoint. Read-only: the access token is used as-is,
// never refreshed here, so we don't race Claude Code's own refresh.
const CREDS = process.env.CLAUDE_CREDENTIALS || '/home/ubuntu/.claude/.credentials.json';

let lastPlan = null;

const fetchPlan = async () => {
  const { claudeAiOauth: oauth } = JSON.parse(await readFile(CREDS, 'utf8'));

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`oauth/usage HTTP ${res.status}`);
  const data = await res.json();

  const window = (w) =>
    w ? { utilization: w.utilization, resetsAt: w.resetsAt || w.resets_at || null } : null;

  return {
    subscription: oauth.subscriptionType || null,
    fetchedAt: new Date().toISOString(),
    fiveHour: window(data.five_hour),
    sevenDay: window(data.seven_day),
    sevenDayOpus: window(data.seven_day_opus),
    sevenDaySonnet: window(data.seven_day_sonnet),
  };
};

const snapshot = async () => {
  const usage = JSON.parse(await readFile(USAGE_FILE, 'utf8'));

  const entries = Object.entries(usage)
    .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))
    .slice(0, MAX_ROOMS);

  const totals = Object.values(usage).reduce(
    (acc, r) => ({
      messages: acc.messages + (r.messages || 0),
      turns: acc.turns + (r.turns || 0),
      tools: acc.tools + (r.tools || 0),
      cost: acc.cost + (r.cost || 0),
    }),
    { messages: 0, turns: 0, tools: 0, cost: 0 },
  );

  let planError = null;
  try {
    lastPlan = await fetchPlan();
  } catch (err) {
    planError = err.message;
  }

  return {
    updatedAt: new Date().toISOString(),
    roomCount: Object.keys(usage).length,
    totals,
    rooms: Object.fromEntries(entries),
    plan: lastPlan,
    planError,
  };
};

let lastText = '';

// Timestamps move on every poll; only the counters decide whether to re-edit.
const stable = (text) => text.replace(/"(updatedAt|fetchedAt)":"[^"]*"/g, '');

const push = async () => {
  const text = JSON.stringify(await snapshot());
  if (stable(text) === stable(lastText)) return;
  await rc('chat.update', { roomId: USAGE_ROOM_ID, msgId: USAGE_MSG_ID, text });
  lastText = text;
  console.log(`${new Date().toISOString()} pushed snapshot (${text.length} chars)`);
};

const safePush = () => push().catch((err) => console.error('push failed:', err.message));

safePush();
setInterval(safePush, POLL_MS);

let debounce;
watch(USAGE_FILE, () => {
  clearTimeout(debounce);
  debounce = setTimeout(safePush, 1_000);
});

console.log(`usage-sync watching ${USAGE_FILE} -> message ${USAGE_MSG_ID}`);
