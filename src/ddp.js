// Minimal DDP client for the Rocket.Chat Realtime API.
//
// Rocket.Chat's realtime layer is Meteor's DDP over a WebSocket at /websocket.
// We only need three things from it — log in with the personal access token,
// subscribe to the message stream, and stay connected — so this is hand-rolled
// rather than pulling in a Meteor client. Node's global WebSocket is used, so
// there is no runtime dependency here at all.
//
// Subscribing to the room id `__my_messages__` is the important trick: it
// delivers every message in every room the authenticated user is subscribed to,
// so the bot does not need a subscription per channel and picks up new channels
// the moment it is added to them.

import { EventEmitter } from "node:events";

const PING_TIMEOUT_MS = 45_000;

export class RocketChatRealtime extends EventEmitter {
  /**
   * @param {{url: string, authToken: string, streamRoom?: string}} options
   */
  constructor({ url, authToken, streamRoom = "__my_messages__" }) {
    super();
    // https -> wss, http -> ws.
    this.wsUrl = url.replace(/^http/, "ws").replace(/\/+$/, "") + "/websocket";
    this.authToken = authToken;
    this.streamRoom = streamRoom;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map(); // method call id -> {resolve, reject}
    this.closed = false;
    this.backoffMs = 1000;
    this.watchdog = null;
  }

  connect() {
    this.closed = false;
    this.#open();
  }

  close() {
    this.closed = true;
    clearTimeout(this.watchdog);
    try {
      this.ws?.close();
    } catch {
      // Already gone — nothing to clean up.
    }
  }

  #open() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.#send({ msg: "connect", version: "1", support: ["1"] });
    });

    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return; // DDP heartbeats and noise that isn't JSON — ignore.
      }
      this.#handle(frame);
    });

    ws.addEventListener("error", (event) => {
      this.emit("warn", `websocket error: ${event.message || "unknown"}`);
    });

    ws.addEventListener("close", () => {
      clearTimeout(this.watchdog);
      // Reject anything still in flight so callers don't hang forever.
      for (const { reject } of this.pending.values()) {
        reject(new Error("Realtime connection closed"));
      }
      this.pending.clear();
      this.emit("disconnected");
      if (this.closed) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      this.emit("warn", `reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.#open(), delay);
    });
  }

  #send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // The server pings us; if it goes quiet the socket is wedged and we tear it
  // down so the close handler's reconnect logic runs.
  #armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.emit("warn", "no ping from server, resetting connection");
      try {
        this.ws?.close();
      } catch {
        /* the close handler reconnects either way */
      }
    }, PING_TIMEOUT_MS);
  }

  #handle(frame) {
    switch (frame.msg) {
      case "connected":
        this.backoffMs = 1000; // a real connection resets the retry curve
        this.#armWatchdog();
        this.#login().catch((error) => this.emit("error", error));
        return;

      case "ping":
        this.#send({ msg: "pong", ...(frame.id ? { id: frame.id } : {}) });
        this.#armWatchdog();
        return;

      case "result": {
        const waiter = this.pending.get(frame.id);
        if (!waiter) return;
        this.pending.delete(frame.id);
        if (frame.error) {
          waiter.reject(
            new Error(frame.error.reason || frame.error.message || "DDP method failed"),
          );
        } else {
          waiter.resolve(frame.result);
        }
        return;
      }

      case "changed": {
        if (frame.collection !== "stream-room-messages") return;
        const message = frame.fields?.args?.[0];
        if (message) this.emit("message", message);
        return;
      }

      default:
        return; // added/ready/updated/nosub — not needed here
    }
  }

  call(method, params = []) {
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ msg: "method", method, id, params });
    });
  }

  async #login() {
    // A Rocket.Chat personal access token doubles as a Meteor resume token.
    const result = await this.call("login", [{ resume: this.authToken }]);
    this.emit("login", result);
    this.#send({
      msg: "sub",
      id: `sub-${++this.nextId}`,
      name: "stream-room-messages",
      params: [this.streamRoom, false],
    });
    this.emit("ready");
  }
}
