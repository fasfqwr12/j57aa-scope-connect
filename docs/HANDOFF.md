# 交接说明（HANDOFF）

> 给接手的人：这份文档假设你**没有参与过本项目**。读完第 1～4 节你应该能跑起来并做完一次完整升级；第 5 节之后是维护时需要知道的东西。
> 最后更新：2026-11-04 · 对应提交 `1d8d12e` · 线上版本号 `ui6-10`

---

## 1. 这是什么

J57AA 枪瞄的**浏览器端双板 OTA 上位机**（纯前端 PWA，无后端）。

它做三件事：

1. 经 BLE 检测主控 W515 与副板 N32 的运行状态、版本、APP 大小/CRC；
2. 选择固件文件（本地或在线库），核对大小、SHA-256、CRC、镜像头；
3. 通过 BLE 把 APP 镜像写进设备并让 Boot 校验。

**不做的事**（别期待）：

- 不刷 Boot。Boot 只能 Keil + ST-Link（或既有 console 流程）烧；
- 不写 Profile/DOPE 到设备（协议未定版，界面会返回 `PROFILE_WRITE_NOT_DEFINED`）；
- 不支持 iOS Safari 的 BLE（只有 PC Chrome/Edge、Android Chrome）。

---

## 2. 三个入口

| 用途 | 地址 |
|---|---|
| 线上直接用（别人只看效果） | https://fasfqwr12.github.io/j57aa-scope-connect/ |
| 源码仓库 | `git@github.com:fasfqwr12/j57aa-scope-connect.git`（branch `main`） |
| 本地跑 | `cd <仓库> && python -m http.server 5188` → http://127.0.0.1:5188/ |

部署方式：**没有 CI 工作流**，GitHub Pages 直接吃 `main` 分支。`git push origin main` 后 1～2 分钟线上就变。
线上版本号可以自证：查看线上 `index.html` 里 `<script src="./src/app.js?v=xxx">` 的 `v`，与本地一致即为同版。

---

## 3. 五分钟跑通（不接硬件）

```powershell
cd j57aa-scope-connect
python -m http.server 5188
# 浏览器打开（注意两个参数都要有）
http://127.0.0.1:5188/index.html?admin=1&fake=1
```

- `fake=1` 注入仿真设备（`src/debug/fake-device.js`，全协议模拟），状态栏显示「仿真设备」；
- `admin=1` 才会挂 `window.__ota` 测试 API 并发版面板；**只写 `fake=1` 不生效**（这是常见踩坑）。

进入「固件升级」页 → 点「检测双板状态」→ 确认弹窗 → 约 3 秒出双板信息 → 点「在线固件库」→ 选 `N32-APP-v1.6.0-20260916.hex` → 右卡应显示 `34940B / 0xFC66B04A`（这两个值读自镜像头，不是现算）。

控制台可用：`__ota.devices()` / `__ota.ota()` / `__ota.tap()`。

---

## 4. 真机升级（现场流程）

前置：Chrome/Edge；页面必须是 HTTPS 或 localhost；瞄具上电、未被手机蓝牙或其他标签占用。

1. 「连接 BLE」→ 选设备（E104-BT5005A 透传，服务 `FFF0`，特征 `FFF1`/`FFF2`）；
2. 「检测双板状态」（结果 **60 秒内有效**，过期要重测）；
3. 选固件 → 看版本对比条（升级/相同版本/降级）；
4. 「确认并升级」→ 期间保持页面前台、亮屏、稳定供电；
5. 失败**不会自动重发**擦写，需要人判断后重来。

单次传输档位：默认 `180B / 4ms`；链路不稳选「稳 · 25ms」。

### 4.1 本地上位机（可选，仅开发兜底）

网页自己就能做 BLE 升级，**不需要上位机**。上位机只在两种场景用：①浏览器不支持 Web Bluetooth 时走本地 Bridge；②固件编译/烧录/闭环脚本。

| 项 | 值 |
|---|---|
| 位置 | `E:\phase1\debug_toll\unified-tool` |
| 启动 | 双击 `启动上位机-测距.cmd`（内部 `start_unified_instance.ps1 -Instance range`） |
| 端口 | `127.0.0.1:8766`（API 前缀 `/api/call`） |
| 停止 | `停止上位机-测距.cmd` |
| 另一个实例 | `启动上位机-滑台.cmd`（滑台/其它工位，端口另配） |
| 依赖 | 纯 Python 标准库，无需 pip 安装 |
| 代码仓库 | `git@github.com:fasfqwr12/unified-tool.git`（本地与 `origin/main` 同步） |
| 体积 | 全目录约 6.4 GB，其中 `data`/`_backup`/`runtime`/`data_instances` 是运行数据，不是代码 |

---

## 5. 代码地图

| 路径 | 职责 |
|---|---|
| `index.html` | 单页骨架，OTA 面板 DOM 全在这里 |
| `src/app.js` | 入口：导航、页面装配、模块接线 |
| `src/adapters/web-bluetooth.js` | 真机 BLE 适配器（Web Bluetooth） |
| `src/adapters/local-bridge.js` | 开发兜底：走上位机 `127.0.0.1:8766/api/call` |
| `src/protocol/scope-protocol.js` | 业务协议：测距、环境、Profile、弹道 |
| `src/upgrade/ota-protocol.js` | OTA 帧协议、W515 元数据读取 |
| `src/upgrade/ota-channel.js` | 流式窗口、ACK、重传、超时 |
| `src/upgrade/device-probe.js` | 双板探测（0x02 身份 / 0xF7 主控状态 / 0x3A 副板信息） |
| `src/upgrade/firmware-image.js` | 镜像解析（W515 `.bin`、N32 `.hex`）+ 合法性门禁 |
| `src/upgrade/image-header.js` | 统一镜像头解析（J5AA / FIRM / N3MT 三格式分派） |
| `src/upgrade/w515-ota.js` | W515 APP 升级流程（进 Boot、擦写、校验、回 APP） |
| `src/upgrade/n32-ota.js` | N32 APP 升级流程（经主控代理转发） |
| `src/upgrade/ota-ui.js` | OTA 面板渲染、门禁文案、日志 |
| `src/upgrade/firmware-library.js` | 在线固件库：清单拉取 + SHA-256 核验 |
| `src/upgrade/release-panel.js` | 管理员发版（网页上传固件到 GitHub） |
| `src/debug/fake-device.js` | 全协议仿真设备 |
| `src/debug/protocol-tap.js` | 协议抓包（排查用） |
| `src/ui-refinement.css` / `src/ui/mobile-screens.css` | Quiet Olive 主题 / 移动单屏布局 |
| `firmware/versions.json` | 在线库清单（发布条目在此） |
| `make-release.mjs` | 发版清单生成器（算 size/SHA-256/CRC32、读版本） |

更细的协议与设计依据见 `docs/`（第 9 节有索引）。

---

## 6. 最容易踩的坑（按踩坑频率排序）

### 6.1 改了代码但页面没变 → 缓存版本链

浏览器按 URL 缓存 ES module。**改任何 js/css，必须同步 bump 引用它的 `?v=`，并一路升到 `index.html` 的入口**：

```
index.html  →  src/app.js?v=ui6-10
src/app.js  →  ./upgrade/ota-ui.js?v=inline-15
ota-ui.js   →  ./firmware-image.js?v=j5aa-1
firmware-image.js → ./image-header.js?v=j5aa-1
```

漏掉任何一环，上游拿到的就是旧模块（现象：改了没效果、控制台报旧行号）。改样式同理（`ui-refinement.css?v=inline-20`）。

### 6.2 仿真模式没反应 → 少了 `admin=1`

`?fake=1` 单独无效，必须 `?admin=1&fake=1`。

### 6.3 检测结果突然失效 → 60 秒快照过期

检测快照 60 秒有效，过期后升级按钮变灰、提示重新检测。这是设计，不是 bug。

### 6.4 文件在命令行里是乱码 → Tipray 加密

本机装了天锐绿盾（Tipray），`index.html`、`make-release.mjs`、`README.md` 等在磁盘上是密文：
`Get-Content` / `Select-String` / Python 直接读会看到 `} [...` 之类乱码，但 VSCode、git、浏览器读是明文。

- 用 VSCode / 本会话的 read·grep 工具读，别用 pwsh 直接读；
- **交接包必须从 git 产物导出**（`git archive` / `git bundle`），直接 `Copy-Item` 拷出去的是密文，对方打不开。

### 6.5 升级时校验失败 `ERR_VERIFY_FAIL` → Boot 与 APP 的镜像头不配套

现行 W515 Boot 硬性要求 APP 带 `FIRM` magic（`product_config.h: UPGRADE_REQUIRE_APP_METADATA=1`）。若把 APP 换成新的 `J5AA` 头而 Boot 没重烧 → 校验必失败。
**顺序：先升 Boot（Keil/ST-Link），再升带 J5AA 头的 APP。**

### 6.6 N32 的 CRC 有两个口径，别混

- 设备 0x3A 报的、手机卡片显示的 = **meta 口径**（`0xFC66B04A`）；
- 旧 Boot 校验用的是**整像 plain 口径**（`0x9ACE3E2F`）；
- 现行 `0x35` 命令仍发 plain 值（旧 Boot 只认这个）。等 N32 Boot 重编并改成「排除头块」口径后，两者才合一。

详见 `docs/IMAGE_HEADER_SPEC.md` §3.1。

### 6.7 BLE 通道独占

检测/升级期间不能同时用别的页面或手机 App 连同一台设备；否则握手失败或中途断链。

---

## 7. 测试怎么做

```powershell
# 单元/边界（应全绿，18 项）
node --test tests/image-header.test.mjs tests/ota-boundaries.test.mjs

# 主协议测试：37 通过 / 5 失败（已知历史失败，与日常改动无关）
node --test tests/ota.test.mjs
```

页面回归（用 HTTP 打开，不碰真实蓝牙）：

| 文件 | 覆盖 |
|---|---|
| `tests/browser-smoke.html` | 14 种宽度（320～1440）导航、布局、OTA 全交互、几何不变量；`?width=1280` 单跑，应 68/68 |
| `tests/mobile-screen-smoke.html` | 手机单屏外壳、分组、预览（`?width=390&height=844`） |
| `tests/theme-smoke.html` | 九套主题可读性 |

`browser-smoke.html` 里有几条几何硬断言（两卡等高、底三格恒 46px、箭头居中）——**改 OTA 面板布局若报错，先看这几条**，它们是防跳动回归钉。

自动化检查 ≠ 真机验收。真机链路（BLE 握手、分包 ACK、断电恢复）必须上板。

---

## 8. 发版（更新在线固件库）

```powershell
# 1) 生成条目（默认只打印）
node make-release.mjs path\to\N32-APP-v1.7.0.hex --date 2026-11-04 --notes "说明" --recommended

# 2) 确认无误后写入清单
node make-release.mjs path\to\N32-APP-v1.7.0.hex --date 2026-11-04 --notes "说明" --recommended --write

# 3) 固件文件放进 firmware/，清单与文件一起提交
git add firmware && git commit -m "release: N32 v1.7" && git push
```

也可以走网页：「固件升级」页 →「固件库发布」（需 `?admin=1`）→ 填 GitHub PAT（细粒度，仅本仓库 Contents 读写）→ 上传。网页发版会顺带算 SHA-256 并写回 `versions.json`。

---

## 9. 文档索引（`docs/`）

| 文档 | 什么时候看 |
|---|---|
| `UPGRADE_GUIDE.md` | 现场升级操作、16 种镜像组合矩阵 |
| `OTA_PROTOCOL_SPEC.md` | OTA 帧格式、命令字（从固件源码提取） |
| `CURRENT_FIRMWARE_OTA.md` | 当前固件能力边界与证据链 |
| `IMAGE_HEADER_SPEC.md` | **统一镜像头 J5AA v1**、双 CRC 口径、迁移顺序 |
| `OTA_FLOW_INTERACTIONS.md` | 全流程场景（含失败分支） |
| `OTA_TEST_REPORT.md` | 软件验收记录与未覆盖项 |
| `UI_REFINEMENT.md` | 界面设计依据与验收边界 |
| `firmware-io-contract.md` | Profile/DOPE 写入的字段草案（未定版） |
| `BOOT_VERSION_PATCH.md` | Boot 版本可查询的固件侧 patch |
| `OTA_PORT_SPEC.md` | 历史考古：PC 端移植到浏览器 |
| `competitor-workflow.md` | 竞品流程约束（设计取舍依据） |
| `ballistics-validation.md` | 弹道参考解算验证 |
| `firmware/README.md` | 公开候选固件库说明 |

---

## 10. 待办（截至交接时未完成）

| 项 | 现状 | 依赖 |
|---|---|---|
| 固件侧统一 J5AA 头落地 | **未开始**（仅上位机侧解析/规范完成） | 4 个镜像 + 2 个 post_build 脚本 + 双 Boot 重编 |
| N32 `0x35` 改「排除头块」口径 | 未做，仍发 plain CRC | N32 Boot 重编 |
| W515 Boot 按 magic 分派校验 | 未做 | W515 Boot 重编 |
| N32 v1.7 hex 发布到在线库 | 未发布（本地有文件） | 验收后 `make-release.mjs` |
| UI 可选项 | 未做 | 检测弹窗「本次不再提示」、在线库搜索过滤 |

上位机侧已就绪：`src/upgrade/image-header.js` 能读 J5AA/FIRM/N3MT 三格式，卡片显示的是头内自述值（不重算）。

---

## 11. 交接自检清单（对方照着做，8 步）

- [ ] 1. 打开线上地址，页面正常、无控制台报错
- [ ] 2. `python -m http.server 5188` 本地打开同样正常
- [ ] 3. `?admin=1&fake=1` 显示「仿真设备」，点检测 3 秒出双板
- [ ] 4. 在线库选 N32 v1.6 → 右卡 `34940B / 0xFC66B04A`
- [ ] 5. `node --test tests/image-header.test.mjs` → 7 通过
- [ ] 6. `tests/browser-smoke.html?width=1280` → 68 通过
- [ ] 7. 改一处界面文案 + bump 版本链 → 刷新能看到变化（证明懂缓存链）
- [ ] 8. 真机：连 BLE → 检测 → 选固件 → 升级通过（**只有这一步算真验收**）

---

## 12. 权限与外部资源

| 资源 | 位置/说明 |
|---|---|
| GitHub 仓库写权限 | `fasfqwr12/j57aa-scope-connect`（交接时需转移/加协作者） |
| GitHub PAT | 细粒度，仅该仓库 Contents 读写；网页发版用，勿写进代码 |
| 固件源码 | `E:\phase1\debug_toll\` 下 W515 / N32 工程（Keil MDK） |
| 本地上位机 | `E:\phase1\debug_toll\unified-tool`（`启动上位机-测距.cmd`，端口 8766；仓库 `fasfqwr12/unified-tool`） |
| J57AA 专用工具脚本 | `E:\tof\qiangmiao\data\J57AACode_20260507\J57AACode_20260507\tool`（约 43 MB） |
| 旧 OTA console | 上条目录内 `start_ble_ota_console.cmd`（端口 9000，仅历史参考） |
| 构建/烧录脚本 | 上条目录内 `build_n32_range_app.ps1`、`flash_n32_app.py`、`flash_boot_keil.py`、`n32_post_build.py`、`qa_ble_ota_closure.ps1` |
| 硬件 | 瞄具样机、ST-Link、USB 串口、Keil MDK + 对应 pack |

---

## 13. 一句话总结

**前端能改的都在这一个仓库里；刷 Boot 和改镜像头是固件侧的事，两边靠 `docs/IMAGE_HEADER_SPEC.md` 的「0x200 统一头 + 双 CRC 口径」对齐。改代码先想缓存版本链，交接包只认 git 产物。**
