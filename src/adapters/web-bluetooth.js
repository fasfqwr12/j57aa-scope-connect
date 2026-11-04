import { buildBallisticQuery, buildSensorQuery, bytesToHex, findFrames, parseBallisticReply, parseMeasurement, parseSensorReply } from "../protocol/scope-protocol.js?v=20260616_closure1";
import { WireChannel, checkAbort } from "../upgrade/ota-channel.js?v=resync-1";
import { buildProxyFrame, PROXY_FLAG_BALLISTIC_TRANSACTION, PROXY_MODE, PROXY_STATUS } from "../upgrade/ota-protocol.js?v=ballistic-1";

// GLPX 状态码 → 人话（对齐 W515 upgrade_proxy.c 与弹道板终态 0x10-0x15）
const PROXY_STATUS_TEXT = {
  1: "固件判定帧非法（BAD_FRAME）",
  3: "代理通道已被占用（BUSY）：先断开其它会话或重连 BLE",
  4: "会话号不匹配（SESSION_MISMATCH）：请在设备页重连后重试",
  5: "代理未激活（INACTIVE）",
  7: "固件不支持该模式（UNSUPPORTED）：确认主控固件带 upgrade_proxy",
  0x10: "W515 拒绝了无效的 52 字节弹道查询",
  0x11: "W515 等待超时，未收到 N32 的弹道事务终态",
  0x12: "W515 收到的旧式 23 字节弹道回复无效",
  0x13: "N32 已发出查询，弹道板 1.8s 内没有任何返回（检查弹道板供电与串口接线）",
  0x14: "N32 收到弹道板数据，但长度/校验/帧结构无效",
  0x15: "N32 的 USART2 初始化回读或 DMA 发送检查失败"
};
const proxyStatusText = status => PROXY_STATUS_TEXT[Number(status)] || `GLPX 代理状态异常（0x${Number(status || 0).toString(16).toUpperCase()}）`;

export class WebBluetoothAdapter {
  constructor(config, log = () => {}) {
    this.config = config; this.log = log;
    this.device = null; this.server = null; this.rx = null; this.tx = null;
    this.buffer = []; this.connected = false; this.generation = 0;
    this.exclusive = null; this.normalRequests = 0; this.writing = false;
    this.collectDuringExclusive = false;   // 弹道事务：独占期间仍收集业务帧
    this.channel = new WireChannel((bytes, options) => this.writeRaw(bytes, options), log);
    this.notifyHandler = event => this.onNotify(event);
    this.disconnectHandler = () => {
      this.connected = false; this.generation++; this.tx = null;
      this.channel.disconnect(); this.log("WARN", "BLE 已断开；重新连接后需重新检测双板状态");
    };
  }
  supported() { return !!globalThis.navigator?.bluetooth; }
  async connect(options = {}) {
    if (this.exclusive) throw new Error("检测/升级中，不可更换设备");
    if (!this.supported()) throw new Error("当前浏览器不支持 Web Bluetooth；请使用 Android/电脑 Chrome 或 Edge，iOS/微信内置浏览器不支持此升级通道");
    // 顺序关键：requestDevice 必须紧贴用户点击同步发起，前面不能有任何 await。
    // 否则手机 Chrome 的用户手势会过期，设备选择框静默不弹（表现成"点了连接没反应"）。
    const picked = options.device || await this.pickDevice();
    if (this.device && this.device !== picked) {
      this.device.removeEventListener("gattserverdisconnected", this.disconnectHandler);
      await this.disconnect();
    }
    this.device = picked;
    this.device.addEventListener("gattserverdisconnected", this.disconnectHandler);
    await this.bindGatt();
    const name = this.device.name || this.device.id;
    this.log("SYS", `BLE 已连接: ${name}`);
    return { connected: true, name };
  }

  // 唤起浏览器的设备选择框（这就是"扫描"）。错误翻译成人话，供页面直接展示。
  async pickDevice() {
    const serviceUuid = normalizeUuid(this.config.serviceUuid);
    const namePrefix = String(this.config.namePrefix || "").trim();
    const scanMode = this.config.scanMode || "all";
    try {
      return await navigator.bluetooth.requestDevice(makeRequestOptions({ scanMode, namePrefix, serviceUuid }));
    } catch (error) {
      if (error.name === "NotFoundError") throw new Error("未选择 BLE 设备：请确认瞄具已开机、未被其它手机或上位机占用，并在选择框中选中 E104-BT5005A");
      if (error.name === "SecurityError") throw new Error("浏览器拦截了设备选择框（点击手势已失效）：请重新点一次「连接」，中间不要切换页面");
      if (error.name === "NotAllowedError") throw new Error("蓝牙权限被拒绝：请在系统设置中允许浏览器使用「蓝牙 / 附近设备」权限后重试");
      if (error.name === "InvalidStateError") throw new Error("设备选择框已在别处打开：请先关闭上一次的选择框再重试");
      throw error;
    }
  }
  async bindGatt() {
    this.connected = false;
    this.rx?.removeEventListener("characteristicvaluechanged", this.notifyHandler);
    try {
      this.server = await this.device.gatt.connect();
      const service = await this.server.getPrimaryService(normalizeUuid(this.config.serviceUuid));
      this.rx = await service.getCharacteristic(normalizeUuid(this.config.rxUuid));
      this.tx = await service.getCharacteristic(normalizeUuid(this.config.txUuid));
      this.rx.addEventListener("characteristicvaluechanged", this.notifyHandler);
      await this.rx.startNotifications();
      this.buffer = []; this.channel.resetConnection(); this.connected = true; this.generation++;
    } catch (error) {
      this.tx = null; this.rx?.removeEventListener("characteristicvaluechanged", this.notifyHandler);
      this.device?.gatt?.disconnect(); throw error;
    }
  }
  async disconnect() {
    this.channel.disconnect(); this.generation++; this.connected = false;
    this.rx?.removeEventListener("characteristicvaluechanged", this.notifyHandler);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.rx = null; this.tx = null; this.buffer = [];
    return { connected: false };
  }
  async reconnect() {
    if (!this.device) throw new Error("没有已授权的 BLE 设备");
    if (!this.isGattConnected() || !this.tx || !this.rx) await this.bindGatt();
    return true;
  }
  isGattConnected() { return !!(this.connected && this.device?.gatt?.connected); }
  beginExclusive(owner) {
    if (this.exclusive || this.normalRequests || this.writing || this.channel.active) throw new Error("蓝牙通道忙，请等上一操作完成");
    if (!this.isGattConnected()) throw new Error("BLE 未连接");
    this.exclusive = owner; this.buffer = [];
    return () => { if (this.exclusive === owner) { this.exclusive = null; this.buffer = []; } };
  }
  assertNormal() { if (this.exclusive) throw new Error("状态检测/升级正在独占蓝牙通道"); }
  requestWire(frame, options) {
    if (!this.exclusive) throw new Error("先获取独占通道再发送升级协议");
    this.log("TX", bytesToHex(frame));
    this.tap?.push?.("tx", frame);
    return this.channel.request(frame, options);
  }
  async writeRaw(value, { chunkSize = 20, withResponse = true, signal } = {}) {
    checkAbort(signal);
    if (!this.isGattConnected() || !this.tx) throw new Error("BLE 未连接");
    if (this.writing) throw new Error("禁止并行 GATT 写入");
    const tx = this.tx, data = Uint8Array.from(value);
    const max = Math.max(20, Math.min(244, Math.floor(chunkSize)));
    if (!Number.isFinite(max)) throw new Error("GATT 分片大小无效");
    this.writing = true;
    try {
      if (withResponse && !tx.properties.write) throw new Error("此特征不支持带响应写入，不能安全升级");
      for (let i = 0; i < data.length; i += max) {
        checkAbort(signal);
        const chunk = data.slice(i, i + max);
        if (withResponse) {
          if (tx.writeValueWithResponse) await tx.writeValueWithResponse(chunk);
          else await tx.writeValue(chunk);
        } else if (tx.properties.writeWithoutResponse && tx.writeValueWithoutResponse) await tx.writeValueWithoutResponse(chunk);
        else if (tx.properties.write && tx.writeValueWithResponse) await tx.writeValueWithResponse(chunk);
        else await tx.writeValue(chunk);
      }
    } finally { this.writing = false; }
  }
  async write(value) {
    this.assertNormal(); this.log("TX", bytesToHex(value));
    this.tap?.push?.("tx", value);
    if (value.length > 244) throw new Error("普通协议帧过长，不能假定 APP 支持分片重组");
    return this.writeRaw(value, { chunkSize: Math.max(20, value.length), withResponse: false });
  }
  onNotify(event) {
    const v = event.target.value;
    const data = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    // 管理员分接：独占（检测/升级）期间的 RX 同样可见，先于独占判断。
    this.tap?.push?.("rx", data);
    // Track complete envelopes even between exclusive sessions.
    this.channel.receive(data);
    if (this.exclusive) {
      // 弹道事务期间通道被 GLPX 占用，但业务帧回复要照样收进 buffer
      if (this.collectDuringExclusive) {
        this.log("RX", bytesToHex(data)); this.buffer.push(...data);
        if (this.buffer.length > 8192) this.buffer.splice(0, this.buffer.length - 8192);
      }
      return;
    }
    this.log("RX", bytesToHex(data)); this.buffer.push(...data);
    if (this.buffer.length > 8192) this.buffer.splice(0, this.buffer.length - 8192);
  }
  async requestFrame(value, timeoutMs) {
    this.assertNormal();
    if (this.normalRequests) throw new Error("普通蓝牙请求忙，禁止并发读取");
    this.normalRequests++;
    try { this.buffer = []; await this.write(value); return await this.waitForFrame(timeoutMs); }
    finally { this.normalRequests--; }
  }
  waitForFrame(timeoutMs, predicate = () => true) {
    this.assertNormal(); const start = performance.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!this.isGattConnected()) { reject(new Error("BLE 已断开")); return; }
        const found = findFrames(this.buffer).find(f => f.checksum_ok && predicate(f.params));
        if (found) { this.buffer = []; resolve(found); return; }
        if (performance.now() - start >= timeoutMs) { reject(new Error("等待 BLE 回复超时")); return; }
        setTimeout(tick, 40);
      }; tick();
    });
  }
  async readEnvironment() {
    const frame = await this.requestFrame(buildSensorQuery(), 2000);
    const sensor = parseSensorReply(frame.params);
    if (!sensor) throw new Error("传感器回复长度不对");
    return { altitude_m: sensor.altitude_m, temp_c: sensor.temperature_c, humidity_pct: sensor.humidity_pct, pressure_pa: sensor.pressure_pa, raw: { rx: bytesToHex(frame.raw) } };
  }
  async listenMeasurement(timeoutS = 5) {
    this.assertNormal();
    if (this.normalRequests) throw new Error("普通蓝牙请求忙，禁止并发读取");
    this.normalRequests++;
    try {
      const frame = await this.waitForFrame(timeoutS * 1000, p => p.length >= 23);
      const m = parseMeasurement(frame.params);
      if (!m) throw new Error("测量回复长度不对");
      return { ...m, raw: { rx: bytesToHex(frame.raw) } };
    } finally { this.normalRequests--; }
  }
  // 设备解算 = GLPX 弹道板单次事务：
  //   START(flags=0x04) → 一帧 52B 查询（W515 转发 N32→弹道板）→ 23B 回复 → 设备自动退出
  // 旧实现只发查询帧：固件不在代理模式，W515 直接丢弃且无任何回包，表现就是「协议不通」。
  async solveDevice(input) {
    const query = buildBallisticQuery(input);
    const session = (Math.floor(Math.random() * 0x7ffffffe) + 1) >>> 0;
    const proxyArgs = { session, baud: 115200, idleMs: 2500, totalMs: 5000 };
    const startPkt = buildProxyFrame(PROXY_MODE.START, { ...proxyArgs, flags: PROXY_FLAG_BALLISTIC_TRANSACTION });
    const stopPkt = buildProxyFrame(PROXY_MODE.STOP, proxyArgs);
    const release = this.beginExclusive("ballistic-solve");
    const trace = { session, tx: [], rx: [] };
    try {
      trace.tx.push({ step: "GLPX START(flags=0x04)", hex: bytesToHex(startPkt) });
      const ack = await this.requestWire(startPkt, { protocol: "proxy", cmd: null, timeoutMs: 3000, chunkSize: startPkt.length });
      trace.rx.push({ step: "GLPX START ack", hex: bytesToHex(ack?.raw || []) });
      const status = Number(ack?.raw?.[8] ?? 0xff);
      if (status !== PROXY_STATUS.OK) throw new Error(proxyStatusText(status));

      this.buffer = [];
      this.collectDuringExclusive = true;
      trace.tx.push({ step: "弹道查询 52B", hex: bytesToHex(query) });
      await this.writeRaw(query, { chunkSize: query.length, withResponse: false });
      const frame = await this.waitBusinessFrame(4200, p => p.length >= 13);
      trace.rx.push({ step: "弹道回复 23B", hex: bytesToHex(frame.raw) });
      const result = parseBallisticReply(frame.params);
      if (!result) throw new Error(`弹道板回复参数区不足 13 字节（收到 ${frame.params.length}B）`);
      return { ...result, source: "DEVICE", raw: trace };
    } catch (error) {
      error.trace = trace;
      throw error;
    } finally {
      this.collectDuringExclusive = false;
      try {
        trace.tx.push({ step: "GLPX STOP", hex: bytesToHex(stopPkt) });
        const ack = await this.requestWire(stopPkt, { protocol: "proxy", cmd: null, timeoutMs: 1200, chunkSize: stopPkt.length });
        trace.rx.push({ step: "GLPX STOP ack", hex: bytesToHex(ack?.raw || []) });
      } catch { /* 单次事务设备端会自行退出；STOP 失败不影响已拿到的结果 */ }
      release();
    }
  }

  // 业务帧（FE FF FF FE ... EF FF FF EF）等待：独占期间也能收，因为弹道事务期间通道被 GLPX 占用
  waitBusinessFrame(timeoutMs, predicate = () => true) {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!this.isGattConnected()) { reject(new Error("BLE 已断开")); return; }
        const found = findFrames(this.buffer).find(f => f.checksum_ok && predicate(f.params));
        if (found) { this.buffer = []; resolve(found); return; }
        if (performance.now() - start >= timeoutMs) { reject(new Error("弹道板无有效回复：N32 在 1.8s 内没有收到任何字节，或回复帧结构/校验不通过")); return; }
        setTimeout(tick, 40);
      }; tick();
    });
  }
  async solveLocal() { throw new Error("浏览器 BLE 模式不能直接调用本地 C，请切换 Bridge 校验"); }
  async syncProfile() { throw new Error("PROFILE_WRITE_NOT_DEFINED"); }
}
function normalizeUuid(uuid) {
  const s = String(uuid || "").trim().toLowerCase();
  return /^[0-9a-f]{4}$/.test(s) ? `0000${s}-0000-1000-8000-00805f9b34fb` : s;
}
function makeRequestOptions({ scanMode, namePrefix, serviceUuid }) {
  const options = { optionalServices: [serviceUuid] };
  if (scanMode === "service") return { ...options, filters: [{ services: [serviceUuid], ...(namePrefix ? { namePrefix } : {}) }] };
  if (scanMode === "name" && namePrefix) return { ...options, filters: [{ namePrefix }] };
  return { ...options, acceptAllDevices: true };
}
