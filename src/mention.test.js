// node --test src/mention.test.js
//
// These rules decide whether the bot speaks at all, and mangled text is what
// reaches Claude as the request, so both halves are worth pinning down. The
// "claude-demo" cases exist because an earlier `\b` boundary silently turned
// "create a channel called claude-demo" into "create a channel called -demo".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsMe, stripMention } from "./mention.js";

const me = { username: "claude", _id: "BOT123" };
const msg = (text, extra = {}) => ({ msg: text, ...extra });

test("an explicit @mention addresses the bot", () => {
  assert.equal(mentionsMe(msg("@claude hello"), me), true);
  assert.equal(mentionsMe(msg("hey @claude can you look"), me), true);
});

test("a resolved mentions[] entry addresses the bot", () => {
  assert.equal(mentionsMe(msg("hello", { mentions: [{ _id: "BOT123" }] }), me), true);
  assert.equal(mentionsMe(msg("hello", { mentions: [{ username: "claude" }] }), me), true);
  assert.equal(mentionsMe(msg("hello", { mentions: [{ username: "someone" }] }), me), false);
});

test("a bare name addresses the bot", () => {
  assert.equal(mentionsMe(msg("claude: what is up"), me), true);
  assert.equal(mentionsMe(msg("ask claude about it"), me), true);
});

test("an unrelated message does not", () => {
  assert.equal(mentionsMe(msg("how much disk is free?"), me), false);
  assert.equal(mentionsMe(msg(""), me), false);
});

test("the name as a prefix of a longer word is not a mention", () => {
  assert.equal(mentionsMe(msg("the claude-demo channel is broken"), me), false);
  assert.equal(mentionsMe(msg("claudebot did it"), me), false);
});

test("stripping removes the address and keeps the request", () => {
  assert.equal(stripMention("@claude hello there", me), "hello there");
  assert.equal(stripMention("claude: what is up", me), "what is up");
  assert.equal(stripMention("claude, restart it", me), "restart it");
  assert.equal(stripMention("hey @claude, look at this", me), "hey look at this");
});

test("stripping leaves hyphenated names intact", () => {
  assert.equal(
    stripMention('@claude create a channel called claude-demo, topic "made by claude"', me),
    'create a channel called claude-demo, topic "made by claude"',
  );
});

test("stripping leaves a mid-sentence bare name alone", () => {
  // Only a LEADING bare name is an address; elsewhere it's just a word.
  assert.equal(stripMention("ask claude about it", me), "ask claude about it");
});

test("a regex-special username is treated literally", () => {
  const odd = { username: "c.aude", _id: "X" };
  assert.equal(mentionsMe(msg("claude hello"), odd), false);
  assert.equal(mentionsMe(msg("c.aude hello"), odd), true);
});
