import {
  buildBallisticQuery,
  buildSensorQuery,
  bytesToHex,
  findFrames,
  parseBallisticReply,
  parseMeasurement,
  parseSensorReply
} from "../protocol/scope-protocol.js";

export class WebBluetoothAdapter {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.device = null;
    this.server = null;
    this.rx = null;
    this.tx = null;
    this.buffer = [];
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
    const filters = [];
    const namePrefix = String(this.config.namePrefix || "").trim();
    if (namePrefix) filters.push({ namePrefix, services: [serviceUuid] });
    filters.push({ services: [serviceUuid] });

    this.device = await navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [serviceUuid]
    });
    this.device.addEventListener("gattserverdisconnected", () => {
      this.connected = false;
      this.log("WARN", "BLE 已断开");
    });
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(serviceUuid);
    this.rx = await service.getCharacteristic(normalizeUuid(this.config.rxUuid));
    this.tx = await service.getCharacteristic(normalizeUuid(this.config.txUuid));
    await this.rx.startNotifications();
    this.rx.addEventListener("characteristicvaluechanged", ev => this.onNotify(ev));
    this.connected = true;
    this.log("SYS", `BLE 已连接: ${this.device.name || this.device.id}`);
    return { connected: true, name: this.device.name || this.device.id };
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
