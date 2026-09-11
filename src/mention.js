// Working out whether a message is addressed to the bot, and stripping the
// address off it.
//
// Its own module because the boundary rules are fiddly enough to deserve
// tests: the bot's name inside a regex must not be treated as a pattern, and
// must not match when it is only the prefix of a longer word. `\b` ends a word
// at a hyphen, so a naive `claude\b` matches inside "claude-demo" — which both
// misreads that as a mention and mangles the text when stripping.
// `(?![\w-])` is what keeps "claude-demo" one token.

const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this message address the bot, by @mention or by leading bare name? */
export function mentionsMe(message, me) {
  if (message.mentions?.some((m) => m._id === me._id || m.username === me.username)) {
    return true;
  }
  // Fall back to a text check: mentions[] is empty when the username is typed
  // without the client resolving it into a real mention.
  return new RegExp(`(^|\\s)@?${escape(me.username)}(?![\\w-])`, "i").test(message.msg || "");
}

/** Remove the address, leaving the actual request. */
export function stripMention(text, me) {
  const name = escape(me.username);
  return String(text || "")
    // An explicit "@claude" anywhere is addressing, never content.
    .replace(new RegExp(`@${name}(?![\\w-])[:,]?`, "gi"), "")
    // A bare leading "claude, ..." / "claude: ..." is also addressing. Only at
    // the start, so "ask claude about it" keeps its words.
    .replace(new RegExp(`^\\s*${name}(?![\\w-])[:,]?\\s+`, "i"), "")
    // Removing an address from mid-sentence leaves a double space behind.
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
