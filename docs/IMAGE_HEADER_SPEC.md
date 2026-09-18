# J57AA 统一镜像头规范（J5AA Image Header v1）

> 目标：所有 J57AA 镜像（W515/N32 × APP/Boot）在**固定偏移 image+0x200** 携带自描述信息块；上位机（网页/PC 工具/未来项目）只扫这一个偏移、按 magic 自分发、**只读不算**。行业对照：U-Boot uImage（头部自描述+双CRC）、MCUboot（头+尾部TLV）、ESP-IDF（magic 0xE9+尾部SHA256）。

## 1. 扫描与分发（上位机唯一入口）

| 项 | 规则 |
|---|---|
| 扫描偏移 | **image+0x200**（所有目标所有镜像，永远） |
| 为什么不是 0 | Cortex-M 向量表必须在前（SP@0/复位@4，硬件上电直接取），固定偏移是行业通行做法 |
| 分发依据 | 头 4 字节 magic，见下表 |
| 扫不到 | 返回 null → 走回退（文件名约定/向量检查），**旧固件照常升级** |

| magic | 格式 | 长度 | 状态 | 事实源用途 |
|---|---|---|---|---|
| `0x4141354A` | **J5AA v1 统一头** | 48B | 新（本规范） | 上位机自述解析 + 完整性（hcrc/payload_crc） |
| `0x4649524D` | W515 旧元数据 | 40B | 保留不动 | **W515 Boot 三连校验事实源**（WB:1210-1252） |
| `0x4E334D54` | N32 旧元数据 | 32B | 保留过渡 | **N32 0x3A 上报事实源**（Boot main.c:1214-1249） |

**magic 字节序（易错点）**：magic 以**小端 u32 常量**存储，`dv.getUint32(0x200, true)` 读出的值即上表常量。因此 flash 里的实际字节：

| 格式 | flash 字节 @0x200 | hex dump 读作 |
|---|---|---|
| J5AA | `4A 35 41 41` | "J5AA"（可读，本规范选定） |
| FIRM | `4D 52 49 46` | "MRIF"（反序，历史既定） |
| N3MT | `54 4D 33 4E` | "TM3N"（反序，历史既定） |

J5AA 解析同时兼容反序拼写 `0x4A354141`；FIRM/N3MT 只认历史字节序。

## 2. J5AA v1 字段表（48B @ image+0x200，小端）

| 偏移 | 大小 | 字段 | 说明 |
|---|---|---|---|
| 0x00 | 4 | magic | ASCII `"J5AA"` |
| 0x04 | 2 | header_ver | =1 |
| 0x06 | 1 | **image_type** | 0=APP 1=BOOT（**自我介绍**） |
| 0x07 | 1 | **target** | 0=W515 1=N32 |
| 0x08 | 2 | fw_version | (major<<8)\|minor，同 0x31/0x3A 口径 |
| 0x0A | 2 | hw_version | 0x0100=1.0 |
| 0x0C | 4 | payload_size | **整像大小（含头）** |
| 0x10 | 4 | payload_crc32 | 口径见 §3 |
| 0x14 | 4 | payload_base | flash 绝对地址（如 0x08002000）——上位机连"该烧哪"都从这里读 |
| 0x18 | 4 | flags | bit0=hcrc 有效 bit1=带签名 bit2=min_boot 有效 |
| 0x1C | 2 | min_boot_ver | 该 APP 要求的最小 Boot 版本（Boot/APP 配对） |
| 0x1E | 2 | reserved | 0xFFFF |
| 0x20 | 12 | model | ASCII NUL 结尾，如 "J57AA-N32" |
| 0x2C | 4 | header_crc32 | 头前 44B 的 CRC32（自身不参与） |

## 3. CRC 口径（双 CRC，uImage 同思路）

| CRC | 覆盖范围 | 自引用解法 | 用途 |
|---|---|---|---|
| header_crc32 | 头 [0, 0x2C) 共 44B | **排除法**：hcrc 字段自身不参与 | 防头本身被写坏 |
| payload_crc32 | 整像**排除头块** [0x200, 0x230) | **排除法**：头块整体不参与 | 上位机下载/发布完整性核对；未来 Boot 可采用 |

- 多项式 0xEDB88320、初值 0xFFFFFFFF、末尾取反（标准 CRC-32，与现行 crc32 一致）。
- 排除法天然**幂等**（重跑脚本值不变），与现行 FIRM/N3MT 的 0xFF 掩码法等价成立。
- 现行校验**不受影响**：W515 升级校验仍用 FIRM meta（0xFF 口径三连）；N32 升级校验仍用整像标准 CRC32（Boot main.c:1434 现行）。J5AA 的 CRC 是新增的独立完整性层。

## 3.1 终态口径（双 Boot + 双 APP 一起重编重烧后达成）

| 维度 | 终态规则 |
|---|---|
| 头位置 | **全部 image+0x200**，48B J5AA v1（W515/N32 × APP/Boot 四镜像一致） |
| 校验口径 | **两个 Boot 都用"排除头块"口径**（`[base, base+0x200)` + `[base+0x230, base+size)` 两段 CRC32） |
| 上位机 | **只读不算**：`0x06`/`0x35` 的期望值直接取头里的 `payload_crc32` |
| 三数合一 | 头里存的 = 上位机发的 = Boot 实算的（**N32 的"两个 CRC"问题消失**） |
| 0x82/0x3A 上报 | 读各自/对方 J5AA 头（Boot 版本读 Boot 头，APP 版本读 APP 头），JBVT 嵌入块退役 |
| 旧格式 | Boot 保留三格式分派（FIRM→0xFF 掩码口径、N3MT/无头→plain），供旧库固件刷写与回滚 |

**关键收益**：校验值不再需要上位机现算，彻底实现"上位机只读"；设备上报值与校验值同源，UI 不再出现两个不同 CRC。

## 4. Boot 镜像的头

- N32 Boot（镜像基址 0x08000000）：头在 Boot_image+0x200 = 0x08000200，`image_type=1`。0x3A 上报 Boot 信息改为读自己的头（替代 0x08001FF0 的 "JBVT" 嵌入块）。
- W515 Boot：同款规则。Boot 头的 payload_crc 无人校验（没人升 Boot），纯标识。

## 5. 兼容矩阵

| 场景 | 结果 |
|---|---|
| 旧固件（FIRM/N3MT/无头） | 上位机按 magic 分发或回退 → **照常升级** |
| 新固件（J5AA）+ 现行 Boot | 头是附加信息，Boot 校验逻辑零改动 → **照常升级**（N32 Boot 模式 0x3A 读不到 N3MT → 退回最近一次 0x35 校验值，Boot main.c:1236-1239 已有此兜底） |
| 新固件 + 新上位机 | 类型/目标/版本/大小/CRC/基址全从头里读，只读不算 |
| W515 FIRM | **不再是永久方案**：统一目标是把 W515 也换成 0x200 的 J5AA v1（见 §7 迁移顺序）；但 W515 Boot 升级成功条件硬绑 `meta->magic == FW_META_MAGIC`（bootloader.c:1246，`product_config.h:105` 该门=1），**必须先把 W515 Boot 改成双接受，再发 J5AA 的 W515 APP** |

## 4.1 同一偏移、三种布局的字节对照（为什么要换 Boot 才能统一）

| 偏移 | J5AA v1（48B，统一目标） | FIRM（40B，W515 现状） | N3MT（32B，N32 现状） |
|---|---|---|---|
| +0x00 | magic `J5AA` | magic `FIRM` | magic `N3MT` |
| +0x04 | header_ver u16 + type u8 + target u8 | version u32 | app_version u16 + rsvd u16 |
| +0x08 | fw_version u16 + hw_version u16 | hw_version u32 | app_size u32 |
| +0x0C | payload_size u32 | model[16] 起 | app_crc32 u32 |
| +0x10 | payload_crc32 u32 | model[16] | hw_version u32 |
| +0x14 | payload_base u32 | ↑ | model[12] |
| +0x18 | flags u32 | ↑ | ↑ |
| +0x1C | min_boot u16 + rsvd u16 | ↑ | ↑ |
| +0x20 | **model[12]** | **app_size u32** | —（块仅到 +0x1F） |
| +0x24 | ↑ | **app_crc u32** | — |
| +0x2C | header_crc32 u32 | — | — |

**冲突点**：+0x20 处 J5AA 放 model、FIRM 放 app_size（+0x24 放 app_crc）——两者无法共存于同一 magic 之下，所以 Boot 必须按 magic 分派布局，这是"换 Boot"的根因。

## 6. 上位机解析流程（通用，不挑项目）

```mermaid flowchart TD
  读image+0x200 --> 验magic
  验magic -->|J5AA| 验hcrc --> 读类型/目标/版本/大小/CRC/基址
  验magic -->|FIRM| W515旧解析
  验magic -->|N3MT| N32旧解析
  验magic -->|无| 文件名回退
```

网页实现：`src/upgrade/image-header.js`（零依赖纯函数）；`firmware-image.js` 两个 inspect 均附加归一化 `header` 字段；`ota-ui.js` 版本/说明/目标格优先读 J5AA。

## 7. 固件侧落地清单（需 Keil 重编，未实施）

| 改动点 | 文件 | 内容 |
|---|---|---|
| N32 APP 头结构 | MCU_Slave `SeerLib/SystemAPI/MiniModule_SystemConfig.c` | `n32_app_meta_t` 32B→48B，magic 改 "J5AA"，新增 type/target/min_boot/flags/hcrc 字段（保留 version/size/crc/hw/model 语义） |
| N32 构建脚本 | `tool/n32_post_build.py` | 写 48B：size、payload_crc（排除头块口径）、hcrc（头前 44B）；幂等 |
| N32 Boot 兼容 | MCU_Slave_Boot_N32 `src/main.c` 0x3A meta 读 | magic 判定改双接受（N3MT 或 J5AA），字段偏移按格式分派 |
| **W515 APP 头** | W515 APP `firmware_meta.c` | FIRM 块整体替换为 **0x200 的 48B J5AA 头**（与 N32 完全同布局同偏移） |
| W515 构建脚本 | `post_build_crc.py` | 写 48B J5AA（替换原 FIRM 填写逻辑） |
| **W515 Boot 校验** | `boot_sdk_w515/Core/Src/bootloader.c:1240-1260` | 按 magic 分派：`FIRM`→0xFF 掩码口径+三连（旧）；`J5AA`→排除头块口径+J5AA 三连（新）；`flash_calc_verify_crc` 同步分派 |
| W515 Boot 上报 | 同上 `bootloader.c:451-522` | 0x82/F7 信息按 magic 分派读新头 |
| Boot 镜像头 | 两个 Boot 工程 | 各嵌 48B 头 @Boot_image+0x200（0x3A 自述替代 JBVT）；**Boot 区升级不查 meta**（`bootloader.c:848` 非 APP 地址走 plain CRC），故 Boot 带头无风险 |

## 7.1 迁移顺序（**仅当 Boot 不重烧时**强制；双 Boot + 双 APP 一起重编重烧则本约束消失）

> 前提差异：本节约束来自 `bootloader.c:1246` 的 `meta->magic == FW_META_MAGIC` 硬门（`product_config.h:105` 该门=1）。**若 W515 Boot 与 N32 Boot 都随本次统一一起重编重烧**，则不需要"先升 Boot 再发 APP"的顺序，四镜像可一次全量替换（见 §3.1 终态口径）。

| 步 | 动作 | 前置 | 失败后果 |
|---|---|---|---|
| 1 | W515 Boot 改为双接受并烧录（网页 Boot 流程） | 无 | — |
| 2 | W515 APP 改 0x200 J5AA 头并发布 | 步1 | 未做步1 则 0x06 校验 ERR_VERIFY_FAIL |
| 3 | N32 APP 改 0x200 J5AA 头并发布 | 无（N32 升级不查 meta） | 仅 0x3A 上报退兜底 |
| 4 | N32 Boot 改双接受并出厂/SWD 重烧 | 步3 之后 | 未做则 0x3A 一直用 0x35 兜底值 |
| 5 | 旧固件（FIRM/N3MT/无头） | 永久保留回退路径 | — |

## 8. 与现行三口径的关系（速查）

| 值 | 口径 | 谁写 | 谁用 |
|---|---|---|---|
| W515 meta.appCrc | 0xFF 掩码（0x220-0x227 当 FF） | post_build_crc.py | W515 Boot 三连 + 网页校验候选（**不变**） |
| N32 N3MT app_crc32 | 0xFF 掩码（0x208-0x20F 当 FF） | n32_post_build.py | 0x3A 上报展示（**过渡保留**） |
| N32 校验 CRC | 整像实字节（plain） | 上位机现算 | 0x35 期望值 ↔ Boot 实算（**不变**） |
| **J5AA payload_crc** | **排除头块** | 构建脚本 | 上位机完整性（**新增**） |
