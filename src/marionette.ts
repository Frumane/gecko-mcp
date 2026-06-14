/**
 * Minimal Marionette client — the automation protocol built into *every*
 * Gecko/Firefox-based browser (Firefox, LibreWolf, Waterfox, Zen, Mullvad,
 * Floorp…). Lets gecko-mcp drive any of them, not just Floorp, by attaching to
 * a browser launched with Marionette enabled (`-marionette`, default TCP 2828).
 *
 * Wire format: each message is `<byteLength>:<utf8-json>`. On connect the server
 * sends a hello packet `{applicationType, marionetteProtocol}`. Commands are
 * `[0, id, name, params]`; responses `[1, id, error, result]`.
 */

import { connect, type Socket } from "node:net";

export interface MarionetteOpts {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MarionetteError extends Error {}

export class MarionetteClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private msgId = 0;
  private readonly pending = new Map<number, Pending>();
  private helloResolve: (() => void) | null = null;
  private helloReject: ((e: Error) => void) | null = null;
  private gotHello = false;
  sessionId: string | null = null;

  constructor(opts: MarionetteOpts = {}) {
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? (Number(process.env.MARIONETTE_PORT) || 2828);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Connect and wait for the server's hello packet. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
      const sock = connect({ host: this.host, port: this.port });
      this.socket = sock;
      sock.setNoDelay(true);
      const onErr = (err: Error) =>
        this.gotHello ? this.failAll(err) : reject(new Error(`Cannot reach Marionette at ${this.host}:${this.port} — launch the browser with -marionette. (${err.message})`));
      sock.on("error", onErr);
      sock.on("data", (c) => this.onData(c));
      sock.on("close", () => this.failAll(new MarionetteError("Marionette connection closed.")));
      const t = setTimeout(() => {
        if (!this.gotHello) { sock.destroy(); reject(new Error("Marionette did not send a hello packet in time.")); }
      }, this.timeoutMs);
      t.unref?.();
    });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    if (!this.gotHello && this.helloReject) this.helloReject(err);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Frames: <decimal-length> ':' <payload>
    for (;;) {
      const colon = this.buf.indexOf(0x3a); // ':'
      if (colon < 0) return;
      const lenStr = this.buf.subarray(0, colon).toString("ascii");
      if (!/^\d+$/.test(lenStr)) { this.socket?.destroy(); this.failAll(new MarionetteError("Bad Marionette framing.")); return; }
      const len = Number(lenStr);
      const start = colon + 1;
      if (this.buf.length < start + len) return; // wait for the rest
      const payload = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      this.handle(payload);
    }
  }

  private handle(payload: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    // Hello packet (object, not the [type,id,...] array).
    if (!Array.isArray(msg)) {
      const hello = msg as { marionetteProtocol?: number };
      this.gotHello = true;
      if (hello.marionetteProtocol && hello.marionetteProtocol < 3) {
        this.helloReject?.(new MarionetteError(`Unsupported Marionette protocol ${hello.marionetteProtocol} (need 3+).`));
      } else {
        this.helloResolve?.();
      }
      this.helloResolve = this.helloReject = null;
      return;
    }
    // Response: [type, id, error, result]
    const [, id, error, result] = msg as [number, number, unknown, unknown];
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (error) {
      const e = error as { error?: string; message?: string };
      p.reject(new MarionetteError(e.message || e.error || "Marionette command failed."));
    } else {
      p.resolve(result);
    }
  }

  /** Send a command and resolve with its `result` (often `{ value: … }`). */
  send<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket) return Promise.reject(new MarionetteError("Not connected."));
    const id = ++this.msgId;
    const frame = Buffer.from(JSON.stringify([0, id, command, params]), "utf8");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MarionetteError(`Marionette command "${command}" timed out.`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket!.write(`${frame.length}:`);
      this.socket!.write(frame);
    });
  }

  /** Start a WebDriver session and switch to page ("content") context. */
  async newSession(): Promise<void> {
    const r = await this.send<{ sessionId?: string }>("WebDriver:NewSession", {});
    this.sessionId = r?.sessionId ?? null;
    await this.send("Marionette:SetContext", { value: "content" }).catch(() => {});
  }

  close(): void {
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
  }
}
