# J57AA 固件升级指南（UPGRADE GUIDE）

> 适用：J57AA-2000A 双 MCU 激光测距瞄镜（主控 W515 + 测距板 N32G430）
> 升级工具：网页 App「升级」Tab（手机/电脑浏览器均可） / PC 上位机 unified-tool
> 协议字节级规格见 `docs/OTA_PORT_SPEC.md`（开发者向）；本文面向使用、产线、售后。
> 母本依据：unified-tool `web_api/debug_api.py` + `tools/ble_upgrade_w515_app.py`（已实测可用的代码，非文档抄写）。

---

## 1. 固件命名规范

| 目标 | 文件名模板 | 例子 |
|---|---|---|
| W515 主控 APP | `W515_APP_v主.次.补_月日.bin` | `W515_APP_v1.2.3_0715.bin` |
| W515 主控 BOOT | `W515_BOOT_v主.次.补.bin` | `W515_BOOT_v2.0.0.bin` |
| N32 测距 APP | `N32_APP_v主.次.补_月日.bin` | `N32_APP_v1.0.4_0715.bin` |
| N32 测距 BOOT | `N32_BOOT_v主.次.补.bin` | `N32_BOOT_v1.1.0.bin` |

- 固件内部 `0x200` 偏移有 64B 元数据（magic "FIRM"、版本、型号、appSize、appCrc），**升级工具以元数据为准**识别固件；文件名是给人看的。
- 元数据缺失时（裸 bin），工具按整包 CRC32 校验，也能升，但建议出厂固件都带元数据（post_build.py 自动填充）。

## 2. 升级路径场景矩阵（全组合）

**判断核心只有一条：升级接收方的 Boot 在不在。**

| # | 场景 | W515 | N32 | 升 W515 APP | 升 N32 APP |
|---|---|---|---|---|---|
| 1 | **正常运行（全 APP）** | Boot+APP | Boot+APP | ✓ OTA 直连 | ✓ 经代理 OTA |
| 2 | 出厂空板 | 无固件 | 无固件 | ✗ | ✗ |
| 3 | W515 APP 损坏/被擦 | 有 Boot | Boot+APP | ✓ OTA 直连（Boot 本来就在运行） | ✓ 经代理 OTA |
| 4 | N32 APP 损坏/被擦 | Boot+APP | 有 Boot | ✓ OTA 直连 | ✓ 经代理 OTA（N32 Boot 在应答） |
| 5 | W515 Boot 损坏 | 无 Boot | 任意 | ✗（无接收方） | ✗（代理网关没了） |
| 6 | N32 Boot 损坏 | 任意 | 无 Boot | ✓ OTA 直连 | ✗（无接收方） |
| 7 | W515 在、N32 全空 | Boot+APP | 无固件 | ✓ OTA 直连 | ✗ |

**Boot 本身任何时候都不能 OTA 升级**（Boot 是 OTA 的根，没有二级 Boot），行 2/5/6 一律 **STLink 硬件烧录**：

| 情况 | STLink 操作 |
|---|---|
| 出厂空板 | W515 Boot 烧 0x08000000；N32 Boot 烧 0x08000000（开壳接测距板） |
| W515 Boot 损坏 | STLink 重烧 W515 Boot，之后恢复全 OTA |
| N32 Boot 损坏 | 开壳 STLink 重烧 N32 Boot，之后恢复全 OTA |

## 3. 在线升级操作流程（网页 App）

```mermaid flowchart TD
    A[手机/电脑打开网页] --> B[设备页 连接BLE]
    B --> C[升级Tab 选固件]
    C --> D[选档位 开始]
    D --> E[自动执行+进度条]
    E --> F[校验通过 复位]
    F --> G[App回连确认]
```

1. 打开 https://fasfqwr12.github.io/j57aa-scope-connect/（Android Chrome/Edge；iOS 不支持网页蓝牙）
2. 「设备」页 → 连接 BLE → 状态点变绿
3. 「升级」页 → 选择固件 .bin（或在线固件列表直接点选）→ 工具自动读元数据显示型号/版本
4. 选传输档位：**首次/量产建议「稳定」，验证过链路后用「快速」**
5. 开始升级 → 看阶段条（握手→进Boot→信息→擦除→写入→校验→复位）→ 出现 ✓ 完成
6. 升级中**别关网页、别让手机锁屏**（Chrome 后台会断 BLE）

## 4. 协议交互流程（帧级时序）

### 4.1 W515 主控 OTA（浏览器 ↔ E104-BT5005A ↔ W515 Boot）

| 步 | 方向 | 帧（hex 模板） | 超时 | 说明 |
|---|---|---|---|---|
| 握手 | → | `AA 01 00 04 12 34 56 78 34 81 55` | 1.8s×2 | 回 `AA 81 00 04 [magic 4B]`；Boot=`87654321`，App=`AA55AA55` |
| (App态)进Boot | → | `AA 03 00 00 CRC 55` | 不等 | 设备复位，温交接8轮/重连30轮探Boot |
| Boot信息 | → | `AA 02 00 00 CRC 55` | 5s | 回48B：型号/版本/appStart/appMax/appCrc |
| 擦除 | → | `AA 04 00 09 [起址4B][大小4B][加密] CRC 55` | 120s | 起址=appStart(0x08004000)，4096对齐 |
| 写入 | → | `AA 05 [len] [址4B][数据≤224B] CRC 55` | - | 240B GATT 分片；每6包查状态断点续写 |
| 查状态 | → | `AA 09 00 00 CRC 55` | 1.8s | 回 written_size，落后→续写，异常→报错 |
| 校验 | → | `AA 06 00 10 [址][大小][CRC32][版本] CRC 55` | 12s | err=0x06→换CRC候选重试 |
| 复位 | → | `AA 07 00 00 CRC 55` | 1s | 跳回 App，探 12 轮确认 |
| 完成 | ← | 握手回 `AA55AA55` | - | ✓ 升级成功 |

CRC16 = Modbus（初值 0xFFFF，多项式 0xA001），覆盖 CMD+LEN+PAYLOAD，线上**大端**。校验 CRC32 为标准算法，候选顺序：固件元数据 → 元数据兼容算（0x200+0x20/24 置 0xFF 后整包） → 整包裸算。

### 4.2 N32 测距板（经 W515 代理，网页 → W515 → UART1 → N32 Boot）

| 步 | 帧 | 说明 |
|---|---|---|
| 启代理 | `AA 7E [len] "GLPX" 01 [session] [baud] [idle] [total] CRC` | CRC 含 AA、无 55 尾（与主链差异） |
| 进Boot | 先发 1B 诱饵 `AA` 等150ms，再 `AA 38 [len] "N32A" CRC 55` | N32 App 收到后切 Boot |
| 握手 | `AA 31 [len] "N32B" CRC 55` | 回 "N32B"=Boot 在；"N32A"=还在 App |
| 擦除 | `AA 33 [len] "N32B" [起址4B][大小4B][页0x0800] CRC 55` | App 区 0x08002000-0x0800F7FF，2KB页 |
| 写入 | `AA 34 [len] [01][址4B][数据≤224B] CRC 55` | 尾包补 0xFF 对齐；CRC 按原始字节 |
| 校验 | `AA 35 [len] "N32B" [起址][大小][CRC32] CRC 55` | 失败→断点补写→重擦重写 |
| 进App | `AA 37 [len] "N32B" CRC 55` | 完成 |

### 4.3 关键恢复机制

| 机制 | 触发 | 行为 |
|---|---|---|
| 写入断点续写 | Boot written_size 落后 | 从 written_size 重新续写 |
| 整帧重试 | 响应超时 | 重连 BLE 重发 1 次 |
| 每包ACK降级 | 写入/校验失败 | 自动降 112B×20B×ACK 档 |
| CRC 候选回退 | 校验 err=0x06 | 依次换 3 种 CRC 算法重试 |
| RAW 代理失步 | N32 升级中断流 | 等 2s idle 自动恢复重开代理 |

## 5. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 握手无响应 | 未连接/被占用/未进Boot | 重连 BLE；确认没有手机/上位机同时连 |
| 擦除超时 | Boot 老版本 | 换上位机或 STLink 升 Boot |
| 写入中途断 | 手机锁屏/网页后台 | 保持亮屏；重开后断点续写 |
| 校验总失败 | 固件 CRC 算法不匹配 | 用带元数据的出厂 bin |
| 升完无 App 回应 | App 启动慢/异常 | 断电重开再握手确认；仍无则 STLink |

## 6. 与既有文档/工具的对应

| 本文档章节 | 母本 |
|---|---|
| §4.1 W515 时序 | `tools/ble_upgrade_w515_app.py`（393 行完整流程） |
| §4.2 N32 时序 | `debug_api.py` range_n32_boot_flash（L5304） |
| 帧格式/CRC/常量 | `docs/OTA_PORT_SPEC.md`（462 行，全部带行号） |
| 旧版说明 | `J57AA_PROTOCOL_DEBUG_GUIDE.md`（注意：其握手帧示例 CRC `31 C3` 为笔误，代码实算 `34 81`） |
