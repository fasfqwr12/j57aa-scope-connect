import { buildF7Query, buildOtaFrame, buildProxyFrame, OTA_CMD, N32_CMD, PROXY_MODE, PROXY_STATUS, parseBootInfo, parseW515Mode, parseN32Info, validateW515Window } from "./ota-protocol.js?v=status-first-1";
import { checkAbort } from "./ota-channel.js?v=status-first-1";

export function snapshotIsFresh(snapshot, adapter, now = Date.now()) {
  return !!snapshot && snapshot.deviceId === adapter.device?.id && snapshot.generation === adapter.generation &&
    adapter.isGattConnected() && now >= snapshot.checkedAt && now - snapshot.checkedAt < 60000;
}
export function w515Gate(snapshot) {
  if (!snapshot || !["APP", "BOOT"].includes(snapshot.main.mode)) return "主控运行模式未确认";
  if (!snapshot.routeClear) return "代理通道未确认释放；禁止升级";
  try { validateW515Window(snapshot.main.info); } catch (e) { return e.message; }
  return null;
}
// Status probing never sends 0x03, 0x38, erase, write, verify or reset.
// NORMAL_PROTOCOL temporarily owns UART1. Queries can hold an already-running
// N32 Boot in Boot (main.c:1498-1502); they do not command APP -> Boot or alter Flash.
export class DeviceProbe {
  constructor(adapter, { signal, onLog = () => {}, now = () => Date.now(), sessionId } = {}) {
    this.adapter = adapter; this.signal = signal; this.log = onLog; this.now = now;
    this.sessionId = sessionId || (globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) || 1));
  }
  async query(frame, protocol, cmd, signal = this.signal) {
    checkAbort(signal);
    // Inactive APP dispatch requires a complete 27B GLPX request in one UART burst.
    // Do NOT split it into 20+7 and assume the firmware will reassemble it.
    // A successful GATT write still needs a firmware ACK; no ACK => UNKNOWN.
    return this.adapter.requestWire(frame, { protocol, cmd, timeoutMs: 1800, signal, chunkSize: protocol === "proxy" ? frame.length : 20 });
  }
  async proxy(mode, session = this.sessionId, signal = this.signal) {
    const f = await this.query(buildProxyFrame(mode, { session, baud: 115200, idleMs: 5000, totalMs: 12000, flags: 0 }), "proxy", null, signal);
    return f.payload[4]; // GLPX + status, NO request mode echo.
  }
  async run({ alreadyExclusive = false } = {}) {
    const release = alreadyExclusive ? () => {} : this.adapter.beginExclusive("probe");
    const result = { deviceId: this.adapter.device?.id, generation: this.adapter.generation, checkedAt: 0,
      main: { mode: "UNKNOWN", info: null }, slave: { mode: "UNKNOWN", reason: "尚未探测" },
      proxy: { state: "UNKNOWN" }, routeClear: false };
    let started = false;
    try {
      this.log("SYS", "先查双板，不进 Boot、不擦写；查询可能延长已在运行的 Boot 停留时间");
      try {
        const f = await this.query(buildF7Query(), "f7");
        result.main.info = parseBootInfo(f.payload); result.main.infoSource = "F7";
      } catch (error) { checkAbort(this.signal); result.main.infoError = error.message; }
      try {
        const f = await this.query(buildOtaFrame(OTA_CMD.HANDSHAKE, [0x12, 0x34, 0x56, 0x78]), "w515", 0x81);
        result.main.mode = parseW515Mode(f.payload);
        if (result.main.mode !== "UNKNOWN") {
          const infoFrame = await this.query(buildOtaFrame(OTA_CMD.GET_INFO), "w515", 0x82);
          const info = parseBootInfo(infoFrame.payload);
          if (info && result.main.info && (info.device_id !== result.main.info.device_id || info.app_start !== result.main.info.app_start || info.app_max_size !== result.main.info.app_max_size)) {
            result.main.mode = "UNKNOWN"; result.main.reason = "F7 与 GET_INFO 身份/布局矛盾";
          } else if (info) { result.main.info = info; result.main.infoSource = "GET_INFO"; }
        }
      } catch (error) { checkAbort(this.signal); result.main.reason = error.message; }
      if (result.main.mode === "BOOT") {
        // Current Project.uvprojx has bootloader/protocol/boot_comm, not upgrade_proxy.
        result.slave = { mode: "UNREACHABLE", reason: "当前主控 Boot 无 N32 代理；先恢复主控 APP，再重新探测副板" };
        result.proxy.state = "NOT_AVAILABLE_IN_BOOT"; result.routeClear = true;
        return result;
      }
      if (result.main.mode !== "APP") {
        result.slave.reason = "主控模式未知，无法确认副板通路"; return result;
      }
      const before = await this.proxy(PROXY_MODE.STATUS, 0);
      if (before !== PROXY_STATUS.INACTIVE) {
        result.proxy.state = before === PROXY_STATUS.OK ? "BUSY" : "UNKNOWN";
        result.slave.reason = "代理被占用或状态不明；不抢占现有会话"; return result;
      }
      result.proxy.state = "INACTIVE";
      // From here a lost START ACK means ownership is ambiguous until queried.
      started = true;
      const status = await this.proxy(PROXY_MODE.START);
      if (status !== PROXY_STATUS.OK) {
        result.slave.reason = `代理启动被拒绝: ${status}`; return result;
      }
      result.proxy.state = "OWNED_NORMAL";
      const response = await this.query(buildOtaFrame(N32_CMD.HANDSHAKE, [0x4E, 0x33, 0x32, 0x42]), "n32", 0xB1);
      result.slave = parseN32Info(response.payload);
      if (result.slave.mode === "UNKNOWN") result.slave.reason = "副板应答格式/状态未确认";
      return result;
    } catch (error) {
      checkAbort(this.signal);
      result.slave.reason = error.message + "；无响应不等于没程序";
      return result;
    } finally {
      if (started && this.adapter.isGattConnected()) {
        try {
          // Even cancellation must release ONLY our own session; never wildcard STOP.
          const status = await this.proxy(PROXY_MODE.STATUS, this.sessionId, null);
          if (status === PROXY_STATUS.INACTIVE) result.routeClear = true;
          else if (status === PROXY_STATUS.OK) {
            const stop = await this.proxy(PROXY_MODE.STOP, this.sessionId, null);
            if (stop === PROXY_STATUS.OK || stop === PROXY_STATUS.INACTIVE) result.routeClear = (await this.proxy(PROXY_MODE.STATUS, this.sessionId, null)) === PROXY_STATUS.INACTIVE;
          }
          result.proxy.state = result.routeClear ? "RELEASED" : "CLEANUP_UNCONFIRMED";
        } catch (error) { result.proxy.state = "CLEANUP_UNCONFIRMED"; result.proxy.reason = error.message; }
      }
      result.checkedAt = this.now(); result.generation = this.adapter.generation;
      this.log("SYS", `状态检测结束: W515=${result.main.mode}; N32=${result.slave.mode}; proxy=${result.proxy.state}`);
      release();
    }
  }
}
