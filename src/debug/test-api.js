// 管理员测试 API（仅 ?admin=1）：闭环测试注入点。window.__ota。
// 能力：注入仿真设备（全协议固件模拟）、免弹窗重连已授权真机(getDevices)、读取内部状态。
import { FakeAdapter } from "./fake-device.js?v=f7target-1";

export function initTestApi({ getAdapter, setAdapter, setStatus, getTap, getOtaState }) {
  if (new URLSearchParams(location.search).get("admin") !== "1") return null;
  const api = {
    // 注入仿真设备并连接（替换当前适配器；日志走原通道）
    async connectFake() {
      const prev = getAdapter();
      if (prev?.exclusive) throw new Error("当前适配器独占中，先等操作结束");
      try { await prev?.disconnect(); } catch {}
      const fake = new FakeAdapter((kind, msg) => console.log(`[FAKE ${kind}] ${msg}`));
      if (getTap()) fake.tap = getTap();
      setAdapter(fake);
      const r = await fake.connect();
      setStatus("on", "仿真设备");
      return r;
    },
    // 免弹窗重连已授权真机（浏览器 remembered devices；需曾在此浏览器配对过）
    async reconnectReal() {
      if (!navigator.bluetooth?.getDevices) throw new Error("此浏览器不支持 getDevices");
      const devices = await navigator.bluetooth.getDevices();
      if (!devices.length) throw new Error("无已授权设备记录；需先手动连接一次");
      const d = devices[0];
      const server = await d.gatt.connect();
      return { id: d.id, name: d.name, connected: server.connected, total: devices.length };
    },
    devices() { return { w515: adapterState(getAdapter()?.w515), n32: adapterState(getAdapter()?.n32), proxy: getAdapter()?.proxy }; },
    ota() { return getOtaState ? getOtaState() : null; },
    tap() { const t = getTap(); return t ? { entries: t.entries.length, noise: t.rxNoise } : null; },
    version: "ota-test-1"
  };
  window.__ota = api;
  // ?admin=1&fake=1：自动注入仿真设备（闭环测试入口）
  if (new URLSearchParams(location.search).get("fake") === "1") {
    setTimeout(() => api.connectFake().then(r => console.log("[__ota] 自动连接仿真设备:", r)).catch(e => console.error("[__ota] fake 连接失败:", e)), 300);
  }
  console.log("[__ota] 测试API已就绪：connectFake()/reconnectReal()/devices()/ota()/tap()");
  return api;
}
function adapterState(v) {
  if (!v) return null;
  return { mode: v.mode, written: v.written, appValid: typeof v.appValid === "function" ? v.appValid() : undefined };
}
