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
// Replies have no transaction id. Never pipeline requests or replay mutating commands.
export class WireChannel {
  constructor(write, log = () => {}) { this.write = write; this.log = log; this.decoder = new WireDecoder(); this.pending = null; this.proxyUncertain = false; }
  resetConnection() { this.decoder.reset(); this.proxyUncertain = false; }
  receive(bytes) {
    for (const frame of this.decoder.push(bytes)) {
      const p = this.pending;
      if (p && frame.protocol === p.protocol && (p.cmd == null || frame.cmd === p.cmd)) p.finish(null, frame);
      // Unrelated F7/GLPX/GLPE/MCU packets are not reinterpreted as the awaited reply.
    }
  }
  disconnect() { this.pending?.finish(new Error("BLE 已断开，状态快照已失效")); this.decoder.reset(); }
  async request(bytes, { protocol, cmd, timeoutMs = 1800, signal, chunkSize = 20 } = {}) {
    checkAbort(signal);
    if (this.pending) throw new Error("协议通道忙，禁止并发请求");
    if (protocol === "proxy" && this.proxyUncertain) throw new Error("GLPX 前次交互未确认，需重连后重新检测；不接受可能迟到的无序号回包");
    // Keep partial outer envelopes across requests. Resetting here could expose
    // an embedded ACK in the remaining half of a GLPE event as a new response.
    let p;
    const reply = new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (this.pending !== p) return;
        clearTimeout(p.timer); signal?.removeEventListener("abort", p.cancel); this.pending = null;
        if (error && protocol === "proxy") this.proxyUncertain = true;
        error ? reject(error) : resolve(result);
      };
      p = { protocol, cmd, finish, cancel: () => finish(abortError()) };
      this.pending = p;
      p.timer = setTimeout(() => finish(new Error(`等待 ${protocol} 回复超时`)), timeoutMs);
      signal?.addEventListener("abort", p.cancel, { once: true });
    });
    // A native GATT write can finish after the timeout/abort. Consume its error;
    // await it before letting a caller release the exclusive session.
    reply.catch(() => {});
    try { await this.write(bytes, { chunkSize, withResponse: true, signal }); }
    catch (error) { p.finish(error); throw error; }
    checkAbort(signal);
    return reply;
  }
}
