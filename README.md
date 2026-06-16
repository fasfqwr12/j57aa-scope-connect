# J57AA Scope Connect

独立浏览器/PWA 枪瞄配置 App。主链路按 BLE 设计，兼容 PC Chromium 和 Android Chrome；开发阶段可通过现有上位机 `http://127.0.0.1:8766/api/call` 做本地桥接和 C 弹道核心校验。

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

## 当前限制

固件 Profile/DOPE 写入命令还没有在现有协议中定版，所以 App 里的“同步到瞄具”会先保存本地 Profile，并在协议层返回 `PROFILE_WRITE_NOT_DEFINED`。具体字段建议见 `docs/firmware-io-contract.md`。
