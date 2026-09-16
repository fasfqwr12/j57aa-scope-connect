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
// Proxy 恢复闭环：proxy 交互失败后进入"未确认"态；不再要求重连——静默隔离期
// （QUIET_MS 内无迟到 GLPX 杂帧，杂帧会刷新静默起点）排空在途回包，随后放行
// 下一次 proxy 请求；一旦收到匹配回包（一次成功往返）即重新同步、清除未确认态。
const PROXY_QUIET_MS = 2600;   // 与 RAW 最小安全空闲一致（主控 ~2s 空闲退出代理）
const PROXY_RESYNC_MAX_MS = 10000;
export class WireChannel {
  constructor(write, log = () => {}) {
    this.write = write; this.log = log; this.decoder = new WireDecoder();
    this.pending = null; this.active = null; this.proxyUncertain = false;
    this.proxyUncertainSince = 0; this.proxyStrayCount = 0; this.lastProxyStrayAt = 0;
  }
  resetConnection() {
    this.decoder.reset(); this.proxyUncertain = false;
    this.proxyUncertainSince = 0; this.proxyStrayCount = 0; this.lastProxyStrayAt = 0;
  }
  receive(bytes) {
    for (const frame of this.decoder.push(bytes)) {
      const p = this.pending;
      if (p && frame.protocol === p.protocol && (p.cmd == null || frame.cmd === p.cmd)) { p.finish(frame); continue; }
      // 无主 OTA 帧（迟到回包 / RAW 镜像 / GLPE 事件）：丢弃并刷新隔离静默起点。
      // 健康会话中仅计数无副作用；未确认态下它们会推迟放行，防止被误认成新请求的回包。
      this.proxyStrayCount++; this.lastProxyStrayAt = Date.now();
      if (this.proxyStrayCount <= 3 || this.proxyStrayCount % 500 === 0) {
        this.log("WARN", `丢弃无主帧 ${frame.protocol}/0x${(frame.cmd ?? 0).toString(16)} #${this.proxyStrayCount}`);
      }
    }
  }
  disconnect() {
    this.active?.fail(new Error("BLE 已断开，状态快照已失效")); this.decoder.reset();
  }
  // 未确认态下的静默等待：自失败/最后杂帧起须连续安静 QUIET_MS；有 signal 可中断
  async waitProxyQuiet(signal) {
    const t0 = Date.now();
    for (;;) {
      checkAbort(signal);
      const since = Math.max(this.proxyUncertainSince, this.lastProxyStrayAt);
      const quietFor = Date.now() - since;
      if (quietFor >= PROXY_QUIET_MS) return;
      if (Date.now() - t0 > PROXY_RESYNC_MAX_MS) {
        throw new Error(`GLPX 隔离期未恢复（${this.proxyStrayCount} 个迟到帧仍在到达）；请重连 BLE 后重试`);
      }
      await delay(Math.min(400, PROXY_QUIET_MS - quietFor), signal);
    }
  }
  async request(bytes, { protocol, cmd, timeoutMs = 1800, signal, chunkSize = 20, noWait = false } = {}) {
    checkAbort(signal);
    if (this.active || this.pending) throw new Error("协议通道忙，禁止并发请求");
    if (protocol === "proxy" && this.proxyUncertain) {
      // 不再永久锁死：静默隔离排空迟到帧后放行；一次成功往返（见 finish）即重新同步
      await this.waitProxyQuiet(signal);
    }
    // Never reset partial outer envelopes at request/session boundaries: their
    // remaining bytes may contain mirrored ACKs, which are NOT fresh replies.
    const io = new AbortController();
    let failure = null, resolveReply, rejectReply;
    const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const p = {
      protocol, cmd,
      finish: frame => {
        if (this.pending !== p) return;
        this.pending = null;
        if (protocol === "proxy" && this.proxyUncertain) {
          // 隔离后首次成功往返 = 通道重新同步
          this.proxyUncertain = false; this.proxyUncertainSince = 0;
          this.proxyStrayCount = 0; this.lastProxyStrayAt = 0;
          this.log("SYS", "GLPX 通道已重新同步（隔离期结束，回包匹配）");
        }
        resolveReply(frame);
      },
      fail: error => {
        failure ||= error;
        if (protocol === "proxy") {
          this.proxyUncertain = true;
          if (!this.proxyUncertainSince) this.proxyUncertainSince = Date.now();
        }
        // Cannot retract a native GATT write already running, but stop all later chunks.
        io.abort(failure);
        if (this.pending === p) { this.pending = null; rejectReply(failure); }
      }
    };
    this.active = this.pending = p;
    const cancel = () => p.fail(abortError());
    const timer = noWait ? null : setTimeout(() => p.fail(new Error(`等待 ${protocol} 回复超时`)), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    reply.catch(() => {});
    try {
      await this.write(bytes, { chunkSize, withResponse: true, signal: io.signal });
      if (failure) throw failure;
      if (noWait) { this.pending = null; this.active = null; return null; } // 流式：已发即确认，不等回包
      return await reply;
    } catch (error) {
      p.fail(error); throw failure;
    } finally {
      if (timer) clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (this.pending === p) this.pending = null;
      if (this.active === p) this.active = null;
    }
  }
}
