import { buildBallisticQuery, buildSensorQuery, bytesToHex, findFrames, parseBallisticReply, parseMeasurement, parseSensorReply } from "../protocol/scope-protocol.js?v=20260616_closure1";
import { WireChannel, checkAbort } from "../upgrade/ota-channel.js?v=status-first-1";

export class WebBluetoothAdapter {
  constructor(config, log = () => {}) {
    this.config = config; this.log = log;
    this.device = null; this.server = null; this.rx = null; this.tx = null;
    this.buffer = []; this.connected = false; this.generation = 0;
    this.exclusive = null; this.normalRequests = 0; this.writing = false;
    this.channel = new WireChannel((bytes, options) => this.writeRaw(bytes, options), log);
    this.notifyHandler = event => this.onNotify(event);
    this.disconnectHandler = () => {
      this.connected = false; this.generation++; this.tx = null;
      this.channel.disconnect(); this.log("WARN", "BLE 已断开；重新连接后需重新检测双板状态");
    };
  }
  supported() { return !!globalThis.navigator?.bluetooth; }
  async connect() {
    if (this.exclusive) throw new Error("检测/升级中，不可更换设备");
    if (!this.supported()) throw new Error("当前浏览器不支持 Web Bluetooth；请使用 Android/电脑 Chrome 或 Edge，iOS/微信内置浏览器不支持此升级通道");
    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.disconnectHandler);
      await this.disconnect();
    }
    const serviceUuid = normalizeUuid(this.config.serviceUuid);
    const namePrefix = String(this.config.namePrefix || "").trim();
    const scanMode = this.config.scanMode || "all";
    try { this.device = await navigator.bluetooth.requestDevice(makeRequestOptions({ scanMode, namePrefix, serviceUuid })); }
    catch (error) { if (error.name === "NotFoundError") throw new Error("未选择 BLE 设备，请确认设备开机且未被其它手机/上位机占用"); throw error; }
    this.device.addEventListener("gattserverdisconnected", this.disconnectHandler);
    await this.bindGatt();
    const name = this.device.name || this.device.id;
    this.log("SYS", `BLE 已连接: ${name}`);
    return { connected: true, name };
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
      this.buffer = []; this.channel.decoder.reset(); this.connected = true; this.generation++;
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
    if (this.exclusive || this.normalRequests || this.writing || this.channel.pending) throw new Error("蓝牙通道忙，请等上一操作完成");
    if (!this.isGattConnected()) throw new Error("BLE 未连接");
    this.exclusive = owner; this.buffer = []; this.channel.decoder.reset();
    return () => { if (this.exclusive === owner) { this.exclusive = null; this.buffer = []; this.channel.decoder.reset(); } };
  }
  assertNormal() { if (this.exclusive) throw new Error("状态检测/升级正在独占蓝牙通道"); }
  requestWire(frame, options) {
    if (!this.exclusive) throw new Error("先获取独占通道再发送升级协议");
    this.log("TX", bytesToHex(frame));
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
    return this.writeRaw(value, { chunkSize: 20, withResponse: false });
  }
  onNotify(event) {
    const v = event.target.value;
    const data = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (this.exclusive) { this.channel.receive(data); return; }
    this.log("RX", bytesToHex(data)); this.buffer.push(...data);
    if (this.buffer.length > 8192) this.buffer.splice(0, this.buffer.length - 8192);
  }
  async requestFrame(value, timeoutMs) {
    this.assertNormal(); this.normalRequests++;
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
    this.assertNormal(); this.normalRequests++;
    try {
      const frame = await this.waitForFrame(timeoutS * 1000, p => p.length >= 23);
      const m = parseMeasurement(frame.params);
      if (!m) throw new Error("测量回复长度不对");
      return { ...m, raw: { rx: bytesToHex(frame.raw) } };
    } finally { this.normalRequests--; }
  }
  async solveDevice(input) {
    const frame = await this.requestFrame(buildBallisticQuery(input), 3000);
    const result = parseBallisticReply(frame.params);
    if (!result) throw new Error("设备解算回复长度不对");
    return { ...result, source: "DEVICE", raw: { rx: bytesToHex(frame.raw) } };
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
