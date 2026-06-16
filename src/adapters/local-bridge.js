export class LocalBridgeAdapter {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.connected = false;
    this.name = "Local Bridge";
  }

  async connect() {
    const status = await this.call("debug_get_status").catch(() => null);
    this.connected = !!(status && status.connected);
    this.name = status?.name || status?.port || "Local Bridge";
    this.log("SYS", this.connected ? `Bridge 已连接: ${this.name}` : "Bridge 可用，尚未连接 BLE");
    return { connected: this.connected, name: this.name };
  }

  async disconnect() {
    await this.call("debug_disconnect").catch(() => null);
    this.connected = false;
    return { connected: false };
  }

  async readEnvironment() {
    const r = await this.call("scope_read_sensor");
    if (!r || !r.success) throw new Error(r?.error || "读取环境失败");
    return {
      altitude_m: Number(r.sensor.altitude_m),
      temp_c: Number(r.sensor.temperature_c),
      humidity_pct: Number(r.sensor.humidity_pct),
      pressure_pa: Number(r.sensor.pressure_pa),
      raw: r
    };
  }

  async listenMeasurement(timeoutS = 5) {
    const r = await this.call("scope_read_measurement", timeoutS);
    if (!r || !r.success) throw new Error(r?.error || "未捕获测距");
    return { ...r.measurement, raw: r };
  }

  async solveLocal(input) {
    const r = await this.call("scope_ballistic_solve_local", input);
    if (!r || !r.success) throw new Error(r?.error || "本地 C 解算失败");
    return { ...r.result, source: "LOCAL-C", version: r.version };
  }

  async solveDevice(input) {
    const r = await this.call("scope_ballistic_solve", input);
    if (!r || !r.success) throw new Error(r?.error || "设备解算失败");
    return { ...r.result, source: "DEVICE", raw: r };
  }

  async syncProfile() {
    throw new Error("PROFILE_WRITE_NOT_DEFINED");
  }

  async call(method, ...params) {
    const base = String(this.config.bridgeBase || "http://127.0.0.1:8766").replace(/\/$/, "");
    const response = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params })
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }
}
