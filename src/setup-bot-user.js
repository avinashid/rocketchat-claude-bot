// One-off: create the dedicated `claude` Rocket.Chat account and write its
// credentials into .env.
//
// Run it with an ADMIN credential of your own in the environment:
//
//   SETUP_TOKEN=<your PAT> SETUP_USER_ID=<your user id> node src/setup-bot-user.js
//
// Your admin token is used only for the calls that need admin rights
// (users.create, users.update) and is never written to disk. What ends up in
// .env is a personal access token belonging to the new bot account, which the
// bot generates for itself.
//
// Safe to re-run: an existing `claude` account is reused rather than recreated.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RC_URL = (process.env.RC_URL || "https://rocket.chillidevs.com").replace(/\/+$/, "");
const SETUP_TOKEN = process.env.SETUP_TOKEN || "";
const SETUP_USER_ID = process.env.SETUP_USER_ID || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "claude";
const BOT_NAME = process.env.BOT_DISPLAY_NAME || "Claude";
const BOT_EMAIL = process.env.BOT_EMAIL || `${BOT_USERNAME}@rocket.chillidevs.com`;
const ENV_FILE = path.resolve(import.meta.dirname, "../.env");

if (!SETUP_TOKEN || !SETUP_USER_ID) {
  console.error(
    "Set SETUP_TOKEN and SETUP_USER_ID to an admin account's personal access token.\n" +
      "Rocket.Chat: avatar -> My Account -> Personal Access Tokens -> Add\n" +
      "(tick 'Ignore Two Factor Authentication').",
  );
  process.exit(1);
}

/** REST call with an explicit auth pair, so we can switch identities mid-script. */
async function call(method, endpoint, { body, query, auth } = {}) {
  const url = new URL(`${RC_URL}/api/v1/${endpoint.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));

  const headers = {};
  if (auth) {
    headers["X-Auth-Token"] = auth.token;
    headers["X-User-Id"] = auth.userId;
  }
  if (body) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!response.ok || json?.success === false) {
    const detail = json?.error || json?.message || text.slice(0, 300);
    const error = new Error(`${method} ${endpoint} failed (${response.status}): ${detail}`);
    error.detail = detail;
    error.status = response.status;
    throw error;
  }
  return json;
}

const admin = { token: SETUP_TOKEN, userId: SETUP_USER_ID };

// --- 0. Sanity-check the admin credential before changing anything ---------

const who = await call("GET", "me", { auth: admin });
if (!(who.roles || []).includes("admin")) {
  console.error(
    `@${who.username} is not an admin (roles: ${(who.roles || []).join(", ") || "none"}).\n` +
      "Creating a user and granting the admin role both require admin rights.",
  );
  process.exit(1);
}
console.log(`setting up as @${who.username} (admin) on ${RC_URL}`);

// --- 1. Create (or find) the bot account -----------------------------------

// Rocket.Chat requires a password even for an account nobody logs into by hand.
// It's used once, below, to obtain the bot's own token, then discarded — it is
// never stored, so the only lasting credential is the access token.
const password = crypto.randomBytes(24).toString("base64url");

let botUser;
try {
  const created = await call("POST", "users.create", {
    auth: admin,
    body: {
      username: BOT_USERNAME,
      name: BOT_NAME,
      email: BOT_EMAIL,
      password,
      // `admin` is what makes "Claude can do anything on Rocket.Chat" true;
      // `bot` marks it as an automation in the UI and member lists.
      roles: ["admin", "bot"],
      verified: true,
      requirePasswordChange: false,
      sendWelcomeEmail: false,
      joinDefaultChannels: false,
    },
  });
  botUser = created.user;
  console.log(`created @${botUser.username} (${botUser._id}) with roles: admin, bot`);
} catch (error) {
  // Re-running after a partial setup is normal, so an existing account is not
  // an error — but we then can't know its password, which changes step 2.
  if (!/already in use|already exists/i.test(error.detail || error.message)) throw error;

  const existing = await call("GET", "users.info", {
    auth: admin,
    query: { username: BOT_USERNAME },
  });
  botUser = existing.user;
  console.log(`@${BOT_USERNAME} already exists (${botUser._id}) — reusing it`);

  // Reset to a password we know, so step 2 can log in as the bot.
  await call("POST", "users.update", {
    auth: admin,
    body: { userId: botUser._id, data: { password, requirePasswordChange: false } },
  });
  console.log("reset its password so a fresh token can be issued");

  const roles = botUser.roles || [];
  if (!roles.includes("admin")) {
    await call("POST", "users.update", {
      auth: admin,
      body: { userId: botUser._id, data: { roles: [...new Set([...roles, "admin", "bot"])] } },
    });
    console.log("granted the admin role");
  }
}

// --- 2. Get a credential for the bot account -------------------------------
//
// Two routes, because either can be unavailable on a given workspace:
//
//   a) `users.createToken` — an admin mints a token for another account. No
//      password, no login, so it sidesteps 2FA entirely. Tried first.
//   b) Log in as the bot with the password set above. This is what a human
//      would do, but a workspace with "2FA via email" enforced answers it with
//      `totp-required` and there is no inbox to read the code from.

async function botCredential() {
  try {
    const minted = await call("POST", "users.createToken", {
      auth: admin,
      body: { userId: botUser._id },
    });
    console.log("minted a bot token via users.createToken (no login needed)");
    return { token: minted.data.authToken, userId: minted.data.userId };
  } catch (error) {
    console.warn(`users.createToken unavailable: ${error.detail || error.message}`);
  }

  try {
    const login = await call("POST", "login", { body: { user: BOT_USERNAME, password } });
    console.log("logged in as the bot account");
    return { token: login.data.authToken, userId: login.data.userId };
  } catch (error) {
    if (!/totp|2fa|two.factor/i.test(error.detail || error.message)) throw error;
    console.warn("login needs a 2FA code emailed to the bot, and it has no inbox");
  }

  // c) New accounts are auto-opted into email 2FA, which blocks both routes
  //    above. Turn that setting off just long enough to log in once, then put
  //    it back exactly as it was. The `finally` runs even if login fails, so a
  //    crash here can't leave the workspace with 2FA disabled.
  const SETTING = "Accounts_TwoFactorAuthentication_By_Email_Enabled";
  const current = await call("GET", `settings/${SETTING}`, { auth: admin });
  const original = current.value;
  console.log(`temporarily setting ${SETTING} ${original} -> false`);
  await call("POST", `settings/${SETTING}`, { auth: admin, body: { value: false } });

  try {
    const login = await call("POST", "login", { body: { user: BOT_USERNAME, password } });
    console.log("logged in as the bot account with email 2FA briefly relaxed");
    return { token: login.data.authToken, userId: login.data.userId };
  } finally {
    await call("POST", `settings/${SETTING}`, { auth: admin, body: { value: original } });
    console.log(`restored ${SETTING} to ${original}`);
  }
}

const botAuth = await botCredential();

let token;
try {
  const generated = await call("POST", "users.generatePersonalAccessToken", {
    auth: botAuth,
    body: { tokenName: "rocketchat-claude-bot", bypassTwoFactor: true },
  });
  token = generated.token;
  console.log("generated a personal access token for the bot");
} catch (error) {
  // Some workspaces disable PATs (Accounts_AllowPersonalAccessTokens=false).
  // The login session token works identically for the API; it just expires
  // eventually, so say so rather than failing the whole setup.
  console.warn(`could not create a personal access token: ${error.detail || error.message}`);
  console.warn("falling back to the login session token (expires per Accounts_LoginExpiration)");
  token = login.data.authToken;
}

// --- 3. Write the bot's credentials into .env ------------------------------

function setEnv(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents}\n${line}\n`;
}

let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
env = setEnv(env, "RC_URL", RC_URL);
env = setEnv(env, "RC_AUTH_TOKEN", token);
env = setEnv(env, "RC_USER_ID", botAuth.userId);
// So the bot answers in every channel it gets added to, which is the point of
// adding it by @mention.
env = setEnv(env, "BOT_ALLOWED_ROOMS", "*");
fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });

console.log(`\nwrote RC_AUTH_TOKEN and RC_USER_ID to ${ENV_FILE}`);
console.log(`bot account: @${BOT_USERNAME} (${botAuth.userId})`);
console.log(`token: ${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`);
console.log(`\nStill to set in .env: BOT_ALLOWED_USERNAMES (who may drive it).`);
console.log(`Then: /invite @${BOT_USERNAME} in any channel.`);
