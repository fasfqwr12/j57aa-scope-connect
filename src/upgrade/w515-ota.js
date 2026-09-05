// W515 主控 BLE OTA 会话（浏览器移植版）
// 母本: tools/ble_upgrade_w515_app.py + web/pages/debug_pro.html（详见 docs/OTA_PORT_SPEC.md）
// 流程: 握手→(App态:进Boot+温交接/重连)→GET_INFO→擦除→写入(窗口同步/断点续写)→VERIFY(CRC候选)→二次核对→复位→等App

import {
  OTA_CMD,
  OTA_MAGIC,
  buildOtaFrame,
  buildVerifyCandidates,
  crc32,
  parseBootInfo,
  parseOtaStatus,
  readFirmwareMeta,
  toHex,
  u32be,
  scanOtaFrames
} from "./ota-protocol.js?v=20260703_v3";

export const OTA_PRESETS = {
  fast:   { label: "快速",   gattChunk: 240, chunk: 224, window: 6, delayMs: 3 },
  compat: { label: "兼容",   gattChunk: 240, chunk: 208, window: 6, delayMs: 3 },
  stable: { label: "稳定",   gattChunk: 120, chunk: 112, window: 3, delayMs: 5 },
  safe:   { label: "安全",   gattChunk: 20,  chunk: 40,  window: 1, delayMs: 6 }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class W515OtaSession {
  /**
   * @param adapter WebBluetoothAdapter（已连接或可重连）
   * @param hooks { onLog(type,msg), onStage(stage,label), onProgress(info), onDone(result) }
   */
  constructor(adapter, hooks = {}) {
    this.adapter = adapter;
    this.hooks = hooks;
    this.aborted = false;
  }

  log(type, msg) { this.hooks.onLog?.(type, msg); }
  stage(stage, label) { this.hooks.onStage?.(stage, label); }
  progress(info) { this.hooks.onProgress?.(info); }

  abort() { this.aborted = true; }
  checkAbort() { if (this.aborted) throw new Error("已中止"); }

  // 发一帧并等响应（响应帧 cmd|0x80）
  async send(cmd, payload = [], timeoutMs = 3000) {
    const frame = buildOtaFrame(cmd, payload);
    this.log("TX", toHex(frame));
    this.adapter.resetOtaBuffer();
    await this.adapter.writeRaw(frame, { chunkSize: this.preset?.gattChunk || 240, withResponse: true });
    try {
      const resp = await this.adapter.waitForOtaFrame(cmd, timeoutMs);
      this.log("RX", toHex(resp.raw));
      return resp;
    } catch (e) {
      // BLE 通道整体自动重试 1 次（断连时先按句柄重连，L3299-3325）
      this.log("WARN", `响应超时，重连重试一次: ${e.message}`);
      try { await this.adapter.reconnect(); } catch (re) { /* 忽略，继续重试一次 */ }
      this.adapter.resetOtaBuffer();
      await this.adapter.writeRaw(frame, { chunkSize: this.preset?.gattChunk || 240, withResponse: true });
      const resp = await this.adapter.waitForOtaFrame(cmd, timeoutMs);
      this.log("RX", toHex(resp.raw));
      return resp;
    }
  }

  // 握手：返回 magic（Boot / App）
  async handshake(timeoutMs = 1800) {
    let resp = null;
    try {
      resp = await this.send(OTA_CMD.HANDSHAKE, [0x12, 0x34, 0x56, 0x78], timeoutMs);
    } catch (e) {
      await sleep(120);   // H5928-5932: BLE 失败再试 1 次
      resp = await this.send(OTA_CMD.HANDSHAKE, [0x12, 0x34, 0x56, 0x78], timeoutMs);
    }
    if (resp.payload.length < 4) throw new Error("握手回复长度异常");
    const magic = ((resp.payload[0] << 24) | (resp.payload[1] << 16) | (resp.payload[2] << 8) | resp.payload[3]) >>> 0;
    return magic;
  }

  async getInfo(timeoutMs = 5000) {
    const resp = await this.send(OTA_CMD.GET_INFO, [], timeoutMs);
    const info = parseBootInfo(resp.payload);
    if (!info) throw new Error("Boot 信息回复长度不足");
    return info;
  }

  // 擦除：payload = 起址(4B BE) + 大小(4B BE) + 加密标志(1B)
  async erase(appStart, size, encrypted = false, timeoutMs = 120000) {
    const eraseSize = Math.min(size, Math.ceil(size / 4096) * 4096);
    const payload = [...u32be(appStart), ...u32be(eraseSize), encrypted ? 0x01 : 0x00];
    this.stage("erase", `擦除 0x${appStart.toString(16).toUpperCase()} × ${eraseSize}B`);
    const resp = await this.send(OTA_CMD.ERASE, payload, timeoutMs);
    if (resp.payload.length < 1 || resp.payload[0] !== 0) {
      throw new Error(`擦除失败 err=0x${(resp.payload[0] || 0).toString(16)}`);
    }
    return true;
  }

  // 进 Boot（App 态）：0x03 空帧，发送后不等响应；然后温交接/重连探活
  async enterBootAndWait() {
    this.stage("enterboot", "请求进入 Boot");
    const frame = buildOtaFrame(OTA_CMD.ENTER_UPGRADE, []);
    this.log("TX", toHex(frame));
    this.adapter.resetOtaBuffer();
    try {
      await this.adapter.writeRaw(frame, { chunkSize: 240, withResponse: true });
    } catch (e) {
      this.log("WARN", `发送进Boot帧失败（可能已复位）: ${e.message}`);
    }

    // 温交接：保持连接等 Boot，8 轮 × (250ms 间隔 + 握手 1200ms)
    for (let i = 1; i <= 8; i++) {
      this.checkAbort();
      await sleep(i <= 4 ? 250 : 450);
      if (!this.adapter.isGattConnected()) { this.log("WARN", `温交接 ${i}/8: BLE 已断开`); break; }
      try {
        const magic = await this.handshake(1200);
        this.log("SYS", `温交接 ${i}/8 magic=0x${magic.toString(16).toUpperCase()}`);
        if (magic === OTA_MAGIC.BOOT) return true;
        if (magic === OTA_MAGIC.APP) {
          // App 还活着，补发 0x03
          const again = buildOtaFrame(OTA_CMD.ENTER_UPGRADE, []);
          await this.adapter.writeRaw(again, { chunkSize: 240, withResponse: true });
        }
      } catch (e) { this.log("WARN", `温交接 ${i}/8 无响应`); }
    }

    // 重连循环：最多 30 轮
    for (let i = 1; i <= 30; i++) {
      this.checkAbort();
      await sleep(i < 10 ? 350 : 600);
      if (!this.adapter.isGattConnected()) {
        try {
          await this.adapter.reconnect();
          this.log("SYS", `Boot 重连 ${i}/30 成功`);
        } catch (e) {
          this.log("WARN", `Boot 重连 ${i}/30 失败: ${e.message}`);
          continue;
        }
      }
      try {
        const magic = await this.handshake(1500);
        this.log("SYS", `重连探活 ${i}/30 magic=0x${magic.toString(16).toUpperCase()}`);
        if (magic === OTA_MAGIC.BOOT) return true;
      } catch (e) { /* 继续下一轮 */ }
    }
    throw new Error("等待 Boot 超时（进 Boot 失败）");
  }

  // 写入批次：chunk 4B 对齐、窗口同步（每 window 包查 written_size、断点续写）
  async writeBatch(firmware, appStart) {
    const preset = this.preset;
    const chunk = Math.max(8, Math.floor(preset.chunk / 4) * 4);
    const total = firmware.length;
    const packets = Math.ceil(total / chunk);
    const startTime = performance.now();
    let offset = 0;
    let packetIndex = 0;
    let retries = 0;

    this.stage("write", `写入 ${total}B · ${packets} 包 × ${chunk}B`);
    this.progress({ stage: "write", written: 0, total, chunk, packets, packetIndex: 0, speed: 0 });

    while (offset < total) {
      this.checkAbort();
      const data = firmware.slice(offset, Math.min(offset + chunk, total));
      const ackMode = preset.window === 1;
      const payload = ackMode
        ? [0x01, ...u32be(appStart + offset), ...data]       // 每包 ACK 模式加 0x01 头（L6908）
        : [...u32be(appStart + offset), ...data];
      const frame = buildOtaFrame(OTA_CMD.WRITE, payload);
      this.log("TX", toHex(frame.subarray(0, 24)) + (frame.length > 24 ? "…" : ""));
      await this.adapter.writeRaw(frame, { chunkSize: preset.gattChunk, withResponse: true });
      packetIndex++;
      offset += data.length;

      if (preset.delayMs > 0) await sleep(preset.delayMs);

      // 窗口同步：每 window 包查一次 Boot 状态（L7107）
      const needStatus = (packetIndex % preset.window === 0) || offset >= total;
      if (needStatus && preset.window > 0) {
        const status = await this.getStatusWithRetry(4);
        if (!status) throw new Error("写入状态查询无响应");
        const target = Math.min(offset, total);
        if (status.written_size >= target) {
          // 正常推进
        } else if (status.written_size < total && status.written_size % chunk === 0) {
          // 断点续写（L7176）
          this.log("WARN", `Boot 落后(${status.written_size}/${target})，断点续写`);
          offset = status.written_size;
          packetIndex = Math.ceil(offset / chunk);
        } else {
          throw new Error(`Boot 写入状态异常: written=${status.written_size} target=${target}`);
        }
        // 把 Boot 的实际进度作为真相上报
        this.progress({
          stage: "write",
          written: Math.min(Math.max(status.written_size, 0), total),
          total, chunk, packets, packetIndex,
          speed: (status.written_size / (performance.now() - startTime)) * 1000
        });
      } else {
        this.progress({
          stage: "write", written: offset, total, chunk, packets, packetIndex,
          speed: (offset / (performance.now() - startTime)) * 1000
        });
      }
    }

    // 写完 settle（§2.7：窗口闭环 350ms，否则 2300ms）
    const settle = this.lastWindowClosed ? 350 : 2300;
    this.log("SYS", `写入完成，settle ${settle}ms`);
    await sleep(settle);
    return true;
  }

  get lastWindowClosed() { return this._windowClosed; }

  async getStatusWithRetry(attempts = 4, timeoutMs = 1800) {
    for (let i = 1; i <= attempts; i++) {
      this.checkAbort();
      try {
        const resp = await this.send(OTA_CMD.GET_STATUS, [], timeoutMs);
        const status = parseOtaStatus(resp.payload);
        if (status) return status;
      } catch (e) {
        await sleep(Math.min(350, 60 * i));
      }
    }
    return null;
  }

  // 校验：16B payload（地址/大小/CRC/版本 BE），失败按候选重试
  async verify(appStart, size, candidates, version) {
    for (const cand of candidates) {
      this.checkAbort();
      this.stage("verify", `校验 ${size}B crc=0x${(cand.crc >>> 0).toString(16).toUpperCase()} (${cand.source})`);
      const payload = [...u32be(appStart), ...u32be(size), ...u32be(cand.crc >>> 0), ...u32be(version >>> 0)];
      try {
        const resp = await this.send(OTA_CMD.VERIFY, payload, 12000);
        if (resp.payload.length >= 1 && resp.payload[0] === 0) return cand;
        this.log("WARN", `校验拒绝 err=0x${resp.payload[0]?.toString(16)}，换 CRC 候选`);
      } catch (e) {
        // 超时 → 状态探针（§1.6）
        const status = await this.getStatusWithRetry(2);
        if (status && status.state === 0x20 && status.verify_result === 0) {
          this.log("SYS", "校验超时但状态探针显示成功");
          return cand;
        }
        this.log("WARN", `校验超时: ${e.message}，换候选`);
      }
    }
    throw new Error("全部 CRC 候选校验失败");
  }

  // 完整升级流程
  async run(firmware, presetKey = "fast") {
    this.preset = OTA_PRESETS[presetKey] || OTA_PRESETS.fast;
    const result = { success: false };
    const fw = firmware instanceof Uint8Array ? firmware : new Uint8Array(firmware);

    // 1. 固件解析
    this.stage("parse", "解析固件");
    const meta = readFirmwareMeta(fw);
    let payload, verifySize, verifyCrc, version, candidates;
    if (meta) {
      payload = fw.slice(0, meta.appSize);
      verifySize = meta.appSize;
      candidates = buildVerifyCandidates(fw, meta);
      verifyCrc = candidates[0].crc;
      version = meta.version;
      this.log("SYS", `固件元数据: 版本=0x${version.toString(16)} 型号=${meta.model || "?"} 大小=${meta.appSize}B`);
    } else {
      payload = fw;
      verifySize = fw.length;
      verifyCrc = crc32(fw);
      version = 0;
      candidates = buildVerifyCandidates(fw, null);
      this.log("SYS", `无元数据，整包 CRC32=0x${verifyCrc.toString(16).toUpperCase()}`);
    }

    // 2. 握手
    this.stage("handshake", "握手");
    let magic = await this.handshake(1800);
    this.log("SYS", `握手 magic=0x${magic.toString(16).toUpperCase()}`);

    // 3. App 态 → 进 Boot
    if (magic === OTA_MAGIC.APP) {
      const info0 = await this.getInfo(3000);
      this.log("SYS", `App 信息: 型号=${info0.model} sw=0x${info0.sw_ver.toString(16)}`);
      await this.enterBootAndWait();
    } else if (magic !== OTA_MAGIC.BOOT) {
      throw new Error(`未知握手 magic=0x${magic.toString(16)}`);
    }

    // 4. Boot 信息
    this.stage("info", "读取 Boot 信息");
    const info = await this.getInfo(5000);
    let appStart = info.app_start || 0x08004000;
    if (appStart === 0x08000000) appStart = 0x08004000;      // H6836-6840
    const appMax = info.app_max_size || 108 * 1024;
    this.log("SYS", `Boot: 型号=${info.model} boot=0x${info.boot_ver.toString(16)} appStart=0x${appStart.toString(16)} appMax=${appMax}B`);
    if (verifySize > appMax) throw new Error(`固件过大: ${verifySize} > ${appMax}`);

    // 5. 擦除
    await this.erase(appStart, verifySize, false, 120000);

    // 6. 写入
    this._windowClosed = false;
    await this.writeBatch(payload, appStart);

    // 7. 校验（写后状态探针 + CRC 候选）
    this.stage("verify", "校验");
    const pre = await this.getStatusWithRetry(2);
    if (pre && pre.written_size >= verifySize) this._windowClosed = true;
    const used = await this.verify(appStart, verifySize, candidates, version);

    // 8. 二次核对（MCU 上报 appSize/appCrc）
    const infoAfter = await this.getInfo(3000);
    if (infoAfter.app_size && infoAfter.app_size !== 0xFFFFFFFF &&
        infoAfter.app_crc && infoAfter.app_crc !== 0xFFFFFFFF &&
        (infoAfter.app_size !== verifySize || infoAfter.app_crc !== (used.crc >>> 0))) {
      this.log("WARN", `MCU 核对不一致: size=${infoAfter.app_size}/${verifySize} crc=0x${infoAfter.app_crc.toString(16)}/0x${(used.crc >>> 0).toString(16)}`);
    }

    // 9. 复位 + 等 App
    this.stage("reset", "复位并等待 App");
    try { await this.send(OTA_CMD.RESET, [], 1000); } catch (e) { this.log("WARN", "复位响应忽略"); }
    for (let i = 1; i <= 12; i++) {
      this.checkAbort();
      await sleep(350);
      if (!this.adapter.isGattConnected()) {
        try { await this.adapter.reconnect(); } catch (e) { continue; }
      }
      try {
        const m = await this.handshake(1500);
        this.log("SYS", `App 等待 ${i}/12 magic=0x${m.toString(16).toUpperCase()}`);
        if (m === OTA_MAGIC.APP) {
          result.success = true;
          result.verify = { size: verifySize, crc: used.crc >>> 0, source: used.source };
          this.stage("done", "升级完成");
          return result;
        }
      } catch (e) { /* 继续 */ }
    }
    this.log("WARN", "校验/复位完成，但未确认 App 回应");
    result.success = true;
    result.app_unconfirmed = true;
    result.verify = { size: verifySize, crc: used.crc >>> 0, source: used.source };
    this.stage("done", "完成（App 未确认）");
    return result;
  }
}
