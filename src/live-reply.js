// A reply that updates in place while Claude is still working.
//
// Posts one placeholder message, then rewrites it via chat.update as text
// streams in, so the channel sees progress instead of a long silence. Edits are
// throttled — Rocket.Chat rate-limits API calls per user, and a token-rate edit
// loop would trip it within seconds.

import { postMessage, updateMessage, react } from "./rc.js";
import { chunk } from "./chunk.js";

const EDIT_INTERVAL_MS = Number(process.env.BOT_EDIT_INTERVAL_MS || 2000);
const WORKING = "_working…_";

export class LiveReply {
  /** @param {{roomId: string, threadId?: string, sourceMsgId?: string}} target */
  constructor({ roomId, threadId, sourceMsgId }) {
    this.roomId = roomId;
    this.threadId = threadId;
    this.sourceMsgId = sourceMsgId;
    this.msgId = null;
    this.buffer = "";
    this.tool = null;
    this.lastPush = 0;
    this.timer = null;
    this.closed = false;
    this.chain = Promise.resolve(); // serialises every write to this message
  }

  /** Post the placeholder and mark the source message as seen. */
  async start() {
    const message = await postMessage({
      roomId: this.roomId,
      text: WORKING,
      threadId: this.threadId,
    });
    this.msgId = message?._id ?? null;
    if (this.sourceMsgId) {
      // Best-effort acknowledgement; a missing reaction permission is not worth
      // failing the whole reply over.
      react({ msgId: this.sourceMsgId, emoji: ":eyes:" }).catch(() => {});
    }
    return this.msgId;
  }

  #render() {
    const body = this.buffer.trim();
    if (!body) return this.tool ? `_${this.tool}…_` : WORKING;
    // While streaming, show the tail of what's been written plus a cursor.
    const shown = body.length > 3000 ? `…${body.slice(-3000)}` : body;
    return this.tool ? `${shown}\n\n_${this.tool}…_` : `${shown} ▌`;
  }

  #schedule() {
    if (this.closed || this.timer) return;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastPush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#push();
    }, wait);
  }

  #push() {
    if (this.closed || !this.msgId) return;
    this.lastPush = Date.now();
    const text = this.#render();
    this.chain = this.chain
      .then(() => updateMessage({ roomId: this.roomId, msgId: this.msgId, text }))
      .catch(() => {}); // a dropped intermediate edit is cosmetic
  }

  onText(delta) {
    this.buffer += delta;
    this.#schedule();
  }

  onTool(name) {
    // MCP tools arrive as mcp__rocketchat__rocketchat_post_message; show the
    // useful tail rather than the wire name.
    this.tool = name.replace(/^mcp__rocketchat__(rocketchat_)?/, "");
    this.#schedule();
  }

  /**
   * Write the authoritative answer and stop editing. Long answers keep the
   * first chunk in the placeholder and post the remainder as follow-ups.
   */
  async finish(finalText) {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.chain.catch(() => {});

    const parts = chunk(finalText || "_(no output)_");
    if (!this.msgId) {
      for (const part of parts) {
        await postMessage({ roomId: this.roomId, text: part, threadId: this.threadId });
      }
      return;
    }
    await updateMessage({ roomId: this.roomId, msgId: this.msgId, text: parts[0] });
    for (const part of parts.slice(1)) {
      await postMessage({ roomId: this.roomId, text: part, threadId: this.threadId });
    }
  }

  /** Report a failure in place of the answer. */
  async fail(message) {
    await this.finish(`:warning: ${message}`);
  }
}
