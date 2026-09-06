# J57AA Scope Connect

独立浏览器/PWA 枪瞄配置 App。主链路按 BLE 设计，兼容 PC Chromium 和 Android Chrome；开发阶段可通过现有上位机 `http://127.0.0.1:8766/api/call` 做本地桥接和 C 弹道核心校验。

## 在线访问

```text
https://fasfqwr12.github.io/j57aa-scope-connect/
```

远端访问走 GitHub Pages HTTPS，浏览器 BLE 权限可正常触发。其他人不需要装上位机即可打开配置界面；只有开发调试用的本地 Bridge 需要在各自电脑上运行。

## 定位

- 管理弹药 Profile、枪/归零参数、目标与 SCI 最低能量阈值。
- 配置 HUD 10 个显示分区和 DIST/WIND 互换。
- 连接瞄具读取环境、监听测距、同步 Profile/DOPE。
- 用同一套输入输出预览 X177 阵列落点、SCI X、能量和能否射击。

## 本地运行

```powershell
cd E:\phase1\debug_toll\j57aa-scope-connect
python -m http.server 5188
```

打开：

```text
http://127.0.0.1:5188/
```

## 连接策略

1. 浏览器 BLE：主目标，使用 E104-BT5005A 透传服务 `FFF0/FFF1/FFF2`，也预留可修改 UUID。
2. 上位机 Bridge：开发兜底，调用现有 `scope_read_sensor`、`scope_read_measurement`、`scope_ballistic_solve_local`、`scope_ballistic_solve`。
3. iOS Safari 当前不作为主 BLE 目标，后续如需 iOS 蓝牙应走 Capacitor/原生壳。

## BLE 扫描排查

- 默认使用“显示全部 BLE”，避免设备未广播 UART Service UUID 时被 Chrome 过滤掉。
- 如果设备能选中但连接失败，优先核对 Service/RX/TX UUID，常见透传模块可能是 `FFF0/FFF1/FFF2` 或 `FFE0/FFE1`。
- 如果列表里完全没有设备，确认瞄具处于广播状态，且没有被手机蓝牙、上位机或其他浏览器标签占用。

## 弹道验证

参考解算器使用开源 [`py-ballisticcalc`](https://github.com/o-murphy/py-ballisticcalc) / [PyPI](https://pypi.org/project/py-ballisticcalc/) `2.2.10`，脚本在 `tools/generate_reference_trajectory.py`。

```powershell
python -m pip install py-ballisticcalc==2.2.10
python tools\generate_reference_trajectory.py --profile 308_168_match --max-range-m 1000 --step-m 100
```

完整流程见 `docs/ballistics-validation.md`。网页 JS 只做交互预览，正式校准以开源参考表、固件 C 和实测靶纸三方闭环为准。

## 状态优先的浏览器 OTA

先检测主控与副板，再选择固件并确认升级；当前仅刷写 W515 APP，副板只做独立状态检测。离线与页面模拟测试不能替代真机验收。

- [操作指南及16种镜像组合](docs/UPGRADE_GUIDE.md)。
- [当前固件协议与源码证据](docs/CURRENT_FIRMWARE_OTA.md)。
- [公开候选固件库](firmware/README.md)。
- 离线回归：`node --test tests/ota.test.mjs tests/ota-boundaries.test.mjs`。
- 页面回归：通过 HTTP(S) 打开 `tests/browser-smoke.html`；不会请求真实蓝牙设备。
- 尚无 service worker，不承诺断网冷启动；Boot自升级、N32刷写与ENC均未开放。

## 界面与响应式验收

Console 02 已重做横向导航、深绿顶栏、首页主视觉与独立升级确认区，手机检测操作前置；协议与升级门禁保持不变。详见 [界面重做与验收记录](docs/UI_REFINEMENT.md)。

页面检查覆盖320至1440像素的14种宽度，含临界断点；通过项目 HTTP(S) 地址打开 `tests/browser-smoke.html` 可复现。视口模拟不是真机触摸或蓝牙验收。

## 当前限制

固件 Profile/DOPE 写入命令还没有在现有协议中定版，所以 App 里的“同步到瞄具”会先保存本地 Profile，并在协议层返回 `PROFILE_WRITE_NOT_DEFINED`。具体字段建议见 `docs/firmware-io-contract.md`。
