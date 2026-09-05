import {
  buildBallisticQuery,
  buildSensorQuery,
  bytesToHex,
  findFrames,
  parseBallisticReply,
  parseMeasurement,
  parseSensorReply
} from "../protocol/scope-protocol.js?v=20260616_closure1";
import { scanOtaFrames } from "../upgrade/ota-protocol.js?v=20260703_v3";

export class WebBluetoothAdapter {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.device = null;
    this.server = null;
    this.rx = null;
    this.tx = null;
    this.buffer = [];
    this.otaBuffer = [];
    this.otaFrameWaiter = null;
    this.connected = false;
  }

  supported() {
    return !!navigator.bluetooth;
  }

  async connect() {
    if (!this.supported()) {
      throw new Error("当前浏览器不支持 Web Bluetooth，请用 Chrome/Edge 或切换 Bridge");
    }
    const serviceUuid = normalizeUuid(this.config.serviceUuid);
    const namePrefix = String(this.config.namePrefix || "").trim();
    const scanMode = this.config.scanMode || "all";
    const requestOptions = makeRequestOptions({ scanMode, namePrefix, serviceUuid });

    this.log("SYS", `BLE 扫描: ${scanModeLabel(scanMode)}${namePrefix ? ` / ${namePrefix}` : ""}`);
    try {
      this.device = await navigator.bluetooth.requestDevice(requestOptions);
    } catch (err) {
      if (err?.name === "NotFoundError") {
        throw new Error("没有选中 BLE 设备。扫不到时请用“显示全部 BLE”，并确认设备已开机、未被其他手机或上位机占用");
      }
      throw err;
    }
    this.device.addEventListener("gattserverdisconnected", () => {
      this.connected = false;
      this.log("WARN", "BLE 已断开");
    });
    this.server = await this.device.gatt.connect();
    const deviceName = this.device.name || this.device.id;
    let service;
    try {
      service = await this.server.getPrimaryService(serviceUuid);
      this.rx = await service.getCharacteristic(normalizeUuid(this.config.rxUuid));
      this.tx = await service.getCharacteristic(normalizeUuid(this.config.txUuid));
    } catch (err) {
      await this.disconnect();
      throw new Error(`已选中 ${deviceName}，但没有找到当前 UART 服务/特征。请核对 Service/RX/TX UUID，当前 Service=${serviceUuid}`);
    }
    await this.rx.startNotifications();
    this.rx.addEventListener("characteristicvaluechanged", ev => this.onNotify(ev));
    this.connected = true;
    this.log("SYS", `BLE 已连接: ${deviceName}`);
    return { connected: true, name: deviceName };
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.connected = false;
    return { connected: false };
  }

  async readEnvironment() {
    const frame = await this.requestFrame(buildSensorQuery(), 2000);
    const sensor = parseSensorReply(frame.params);
    if (!sensor) throw new Error("传感器回复长度不对");
    return {
      altitude_m: sensor.altitude_m,
      temp_c: sensor.temperature_c,
      humidity_pct: sensor.humidity_pct,
      pressure_pa: sensor.pressure_pa,
      raw: { rx: bytesToHex(frame.raw) }
    };
  }

  async listenMeasurement(timeoutS = 5) {
    const frame = await this.waitForFrame(timeoutS * 1000, params => params.length >= 23);
    const measurement = parseMeasurement(frame.params);
    if (!measurement) throw new Error("测量回复长度不对");
    return { ...measurement, raw: { rx: bytesToHex(frame.raw) } };
  }

  async solveDevice(input) {
    const frame = await this.requestFrame(buildBallisticQuery(input), 3000);
    const result = parseBallisticReply(frame.params);
    if (!result) throw new Error("设备解算回复长度不对");
    return { ...result, source: "DEVICE", raw: { rx: bytesToHex(frame.raw) } };
  }

  async solveLocal() {
    throw new Error("浏览器 BLE 模式不能直接调用本地 C，请切换 Bridge 校验");
  }

  async syncProfile() {
    throw new Error("PROFILE_WRITE_NOT_DEFINED");
  }

  async requestFrame(bytes, timeoutMs) {
    await this.write(bytes);
    return this.waitForFrame(timeoutMs);
  }

  async write(bytes) {
    if (!this.tx) throw new Error("BLE 未连接");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.log("TX", bytesToHex(data));
    const max = 20;
    for (let i = 0; i < data.length; i += max) {
      const chunk = data.slice(i, i + max);
      if (this.tx.writeValueWithoutResponse) {
        await this.tx.writeValueWithoutResponse(chunk);
      } else {
        await this.tx.writeValue(chunk);
      }
    }
  }

  onNotify(event) {
    const data = new Uint8Array(event.target.value.buffer);
    this.log("RX", bytesToHex(data));
    this.buffer.push(...data);
    this.otaBuffer.push(...data);
    if (this.otaFrameWaiter) this.otaFrameWaiter(data);
  }

  // ===== OTA 升级支持（J57AA W515 BLE OTA）=====

  resetOtaBuffer() {
    this.otaBuffer = [];
  }

  // 原始写入：指定分片大小 + 写响应模式（OTA 用，不走 20B 默认分片）
  async writeRaw(bytes, { chunkSize = 240, withResponse = true } = {}) {
    if (!this.tx) throw new Error("BLE 未连接");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const max = Math.max(20, Math.min(chunkSize, 244));  // L6799 clamp 20..244
    for (let i = 0; i < data.length; i += max) {
      const chunk = data.slice(i, i + max);
      if (withResponse && this.tx.writeValue) {
        await this.tx.writeValue(chunk);
      } else if (this.tx.writeValueWithoutResponse) {
        await this.tx.writeValueWithoutResponse(chunk);
      } else {
        await this.tx.writeValue(chunk);
      }
    }
  }

  // GATT 断线快速重连（device 对象保留，可直接 reconnect）
  async reconnect() {
    if (!this.device) throw new Error("BLE 设备句柄不存在");
    if (!this.device.gatt.connected) {
      this.server = await this.device.gatt.connect();
    }
    if (!this.connected) this.connected = true;
    return true;
  }

  isGattConnected() {
    return !!(this.device?.gatt?.connected);
  }

  // 等待一帧 OTA 响应：AA (cmd|0x80) ... CRC 55；扫描 otaBuffer 并清理已消费字节
  waitForOtaFrame(expectedCmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const tryFrame = () => {
        // 直接调用文件作用域里的 scanOtaFrames（见文件底部 import）
        const { frames, consumed } = scanOtaFrames(this.otaBuffer);
        if (consumed > 0) this.otaBuffer = this.otaBuffer.slice(consumed);
        const want = (expectedCmd | 0x80) & 0xFF;
        const hit = frames.find(f => f.crc_ok && f.cmd === want);
        if (hit) { resolve(hit); return; }
        if (performance.now() - start >= timeoutMs) {
          reject(new Error(`等待响应超时(cmd 0x${want.toString(16)})`));
          return;
        }
        setTimeout(tryFrame, 20);
      };
      tryFrame();
    });
  }

  waitForFrame(timeoutMs, predicate = () => true) {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const frames = findFrames(this.buffer);
        if (frames.length) {
          const found = frames.find(f => f.checksum_ok && predicate(f.params));
          if (found) {
            this.buffer = [];
            resolve(found);
            return;
          }
        }
        if (performance.now() - start >= timeoutMs) {
          reject(new Error("等待 BLE 回复超时"));
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
  }
}

function normalizeUuid(uuid) {
  const text = String(uuid || "").trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(text)) return `0000${text}-0000-1000-8000-00805f9b34fb`;
  return text;
}

function makeRequestOptions({ scanMode, namePrefix, serviceUuid }) {
  const options = { optionalServices: [serviceUuid] };
  if (scanMode === "service") {
    const filters = [{ services: [serviceUuid] }];
    if (namePrefix) filters.unshift({ namePrefix, services: [serviceUuid] });
    return { ...options, filters };
  }
  if (scanMode === "name" && namePrefix) {
    return { ...options, filters: [{ namePrefix }] };
  }
  return { ...options, acceptAllDevices: true };
}

function scanModeLabel(scanMode) {
  if (scanMode === "service") return "按服务 UUID";
  if (scanMode === "name") return "只按设备名";
  return "显示全部 BLE";
}
