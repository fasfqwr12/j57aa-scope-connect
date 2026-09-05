import { WireDecoder } from "./ota-protocol.js?v=status-first-1";
export function abortError() { return new DOMException("操作已取消", "AbortError"); }
export function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
export function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
    const cancel = () => finish(abortError());
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
// Replies have no transaction id. Keep ownership until BOTH write and reply settle.
export class WireChannel {
  constructor(write, log = () => {}) {
    this.write = write; this.log = log; this.decoder = new WireDecoder();
    this.pending = null; this.active = null; this.proxyUncertain = false;
  }
  resetConnection() { this.decoder.reset(); this.proxyUncertain = false; }
  receive(bytes) {
    for (const frame of this.decoder.push(bytes)) {
      const p = this.pending;
      if (p && frame.protocol === p.protocol && (p.cmd == null || frame.cmd === p.cmd)) p.finish(frame);
    }
  }
  disconnect() {
    this.active?.fail(new Error("BLE 已断开，状态快照已失效")); this.decoder.reset();
  }
  async request(bytes, { protocol, cmd, timeoutMs = 1800, signal, chunkSize = 20 } = {}) {
    checkAbort(signal);
    if (this.active || this.pending) throw new Error("协议通道忙，禁止并发请求");
    if (protocol === "proxy" && this.proxyUncertain) throw new Error("GLPX 前次交互未确认，需重连后重新检测；不接受可能迟到的无序号回包");
    // Never reset partial outer envelopes at request/session boundaries: their
    // remaining bytes may contain mirrored ACKs, which are NOT fresh replies.
    const io = new AbortController();
    let failure = null, resolveReply, rejectReply;
    const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const p = {
      protocol, cmd,
      finish: frame => {
        if (this.pending !== p) return;
        this.pending = null; resolveReply(frame);
      },
      fail: error => {
        failure ||= error;
        if (protocol === "proxy") this.proxyUncertain = true;
        // Cannot retract a native GATT write already running, but stop all later chunks.
        io.abort(failure);
        if (this.pending === p) { this.pending = null; rejectReply(failure); }
      }
    };
    this.active = this.pending = p;
    const cancel = () => p.fail(abortError());
    const timer = setTimeout(() => p.fail(new Error(`等待 ${protocol} 回复超时`)), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    reply.catch(() => {});
    try {
      await this.write(bytes, { chunkSize, withResponse: true, signal: io.signal });
      if (failure) throw failure;
      return await reply;
    } catch (error) {
      p.fail(error); throw failure;
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (this.pending === p) this.pending = null;
      if (this.active === p) this.active = null;
    }
  }
}
