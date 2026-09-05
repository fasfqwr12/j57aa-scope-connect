// Current firmware path: explicit preflight -> Boot -> ACK writes -> VERIFY -> RESET.
import { OTA_CMD, buildOtaFrame, parseBootInfo, parseOtaStatus, parseW515Mode, u32be } from "./ota-protocol.js?v=status-first-1";
import { DeviceProbe, w515Gate } from "./device-probe.js?v=status-first-1";
import { inspectFirmware, validateFirmwareForDevice } from "./firmware-image.js?v=status-first-1";
import { checkAbort, delay } from "./ota-channel.js?v=status-first-1";

// No automatic MTU inference, streaming retries, or unverified fast profiles.
export const OTA_PRESETS = Object.freeze({ safe: { label: "保守 ACK", gattChunk: 20, chunk: 40, window: 1, delayMs: 6 } });
export class W515OtaSession {
  constructor(adapter, hooks = {}) {
    this.adapter = adapter; this.hooks = hooks; this.controller = new AbortController();
    this.pause = hooks.delay || delay; this.now = hooks.now || (() => Date.now());
    this.mutatingStarted = false;
  }
  abort() { this.controller.abort(); }
  log(type, text) { this.hooks.onLog?.(type, text); }
  stage(id, label) { this.hooks.onStage?.(id, label); }
  async send(cmd, payload = [], timeoutMs = 4000) {
    checkAbort(this.controller.signal);
    return this.adapter.requestWire(buildOtaFrame(cmd, payload), { protocol: "w515", cmd: cmd | 0x80, timeoutMs, signal: this.controller.signal, chunkSize: 20 });
  }
  async ack(cmd, payload, timeoutMs) {
    const f = await this.send(cmd, payload, timeoutMs);
    if (f.payload.length !== 1 || f.payload[0] !== 0) throw new Error(`0x${cmd.toString(16)} ACK 异常：${Array.from(f.payload).join(",")}`);
    return f;
  }
  async info() {
    const info = parseBootInfo((await this.send(OTA_CMD.GET_INFO)).payload);
    if (!info) throw new Error("设备信息长度不是48字节");
    return info;
  }
  async status() {
    const status = parseOtaStatus((await this.send(OTA_CMD.GET_STATUS)).payload);
    if (!status) throw new Error("Boot 状态回包过短");
    return status;
  }
  async waitMode(expected) {
    for (let i = 0; i < 6; i++) {
      checkAbort(this.controller.signal);
      await this.pause(500, this.controller.signal);
      try {
        if (!this.adapter.isGattConnected()) await this.adapter.reconnect();
        const frame = await this.send(OTA_CMD.HANDSHAKE, [0x12, 0x34, 0x56, 0x78], 1500);
        if (parseW515Mode(frame.payload) === expected) return;
      } catch (error) { checkAbort(this.controller.signal); this.log("WARN", `${expected} 等待 ${i + 1}/6：${error.message}`); }
    }
    throw new Error(`${expected} 运行模式未确认；不能判定升级成功`);
  }
  async run(image, { preset = "safe", confirmed = false, expectedDeviceId, acknowledgeSlaveUnknown = false } = {}) {
    if (!confirmed) throw new Error("需要明确确认后才允许升级");
    if (preset !== "safe") throw new Error("仅开放保守 ACK 模式，快速模式未经真机验证");
    // Reparse a private copy so caller edits cannot change the image during writes.
    const fw = inspectFirmware(image.bytes, image.name.replace(/\.hex$/i, ".bin"), image.target);
    fw.base = image.base;
    const release = this.adapter.beginExclusive("upgrade");
    try {
      this.stage("probe", "重新检测双板状态");
      const snapshot = await new DeviceProbe(this.adapter, { signal: this.controller.signal, onLog: (t, m) => this.log(t, m) }).run({ alreadyExclusive: true });
      this.hooks.onSnapshot?.(snapshot);
      const gate = w515Gate(snapshot);
      if (gate) throw new Error(gate);
      if (expectedDeviceId && snapshot.deviceId !== expectedDeviceId) throw new Error("设备已更换，请重新检测并确认");
      if (!["APP", "BOOT"].includes(snapshot.slave.mode) && !acknowledgeSlaveUnknown) throw new Error("副板未确认；请查看原因并明确选择仅恢复主控");
      validateFirmwareForDevice(fw, snapshot.main.info);
      checkAbort(this.controller.signal);
      if (snapshot.main.mode === "APP") {
        this.stage("enterboot", "请求主控进入 Boot");
        this.mutatingStarted = true;
        await this.ack(OTA_CMD.ENTER_UPGRADE, []);
        await this.waitMode("BOOT");
      }
      this.stage("info", "核对实际 Boot 地址窗口");
      const bootInfo = await this.info();
      if (bootInfo.device_id !== snapshot.main.info.device_id || bootInfo.app_start !== snapshot.main.info.app_start || bootInfo.app_max_size !== snapshot.main.info.app_max_size) throw new Error("进入 Boot 后身份或窗口变化，停止升级");
      const { appStart, size, eraseSize } = validateFirmwareForDevice(fw, bootInfo);
      // All destructive commands are sent ONCE; a lost ACK stops the transaction.
      this.stage("erase", `擦除 APP ${eraseSize}B`);
      this.mutatingStarted = true;
      await this.ack(OTA_CMD.ERASE, [...u32be(appStart), ...u32be(eraseSize), 0], 120000);
      if ((await this.status()).written_size !== 0) throw new Error("擦除后写入计数不为0");
      this.stage("write", "逐包写入并确认 ACK");
      const started = this.now();
      const total = Math.ceil(size / 40);
      for (let offset = 0, index = 0; offset < size; offset += 40, index++) {
        checkAbort(this.controller.signal);
        const data = fw.bytes.slice(offset, Math.min(size, offset + 40));
        await this.ack(OTA_CMD.WRITE, [1, ...u32be(appStart + offset), ...data]);
        const written = offset + data.length;
        if ((index + 1) % 16 === 0 || written === size) {
          const s = await this.status();
          if (s.written_size !== written) throw new Error(`写入计数不一致：设备${s.written_size}，已确认${written}；停止，不盲目续写`);
        }
        this.hooks.onProgress?.({ percent: written / size * 100, written, size, packets: index + 1, totalPackets: total, speed: written / Math.max(0.001, (this.now() - started) / 1000), mode: "20B / ACK40" });
        await this.pause(6, this.controller.signal);
      }
      this.stage("verify", "核对 CRC 与固件元数据");
      await this.ack(OTA_CMD.VERIFY, [...u32be(appStart), ...u32be(size), ...u32be(fw.meta.appCrc), ...u32be(fw.meta.version)], 30000);
      const verified = await this.status();
      if (verified.state !== 0x20 || verified.verify_result !== 1 || verified.verify_addr !== appStart || verified.verify_size !== size || verified.expected_crc !== fw.meta.appCrc || verified.calculated_crc !== fw.meta.appCrc) throw new Error("Boot 校验诊断不一致，禁止复位");
      const installed = await this.info();
      if (installed.app_size !== size || installed.app_crc !== fw.meta.appCrc) throw new Error("写后元数据不一致，禁止复位");
      // No HANDSHAKE between successful VERIFY and RESET: Boot handshake sets STATE_CONNECTED.
      this.stage("reset", "校验成功，请求复位并等待 APP");
      await this.ack(OTA_CMD.RESET, []);
      await this.waitMode("APP");
      const app = await this.info();
      if (app.device_id !== bootInfo.device_id || app.app_size !== size || app.app_crc !== fw.meta.appCrc || app.sw_ver !== (fw.meta.version >>> 16)) throw new Error("APP 回应身份/版本/CRC 不符");
      this.stage("done", "主控 APP 已确认");
      return { success: true, appConfirmed: true, info: app, slave: snapshot.slave, verify: { size, crc: fw.meta.appCrc } };
    } catch (error) {
      this.log("WARN", this.mutatingStarted ? "操作已停止；不自动复位/重发擦写。请重新检测，必要时在 Boot 中完整恢复 APP。" : "前置检查未通过，未擦写固件。");
      throw error;
    } finally { release(); }
  }
}
