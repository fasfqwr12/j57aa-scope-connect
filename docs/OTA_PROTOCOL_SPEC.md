# J57AA OTA 协议说明（当前固件源码提取版）

> 本文全部内容逐条提取自当前固件源码（快照 `J57AACode_20260507/J57AACode_20260507`），每条带 `文件:行号` 证据；所有 hex 示例的 CRC16/CRC32/XOR 均经程序化独立复算验证，未参考任何既有说明文档。源码目录日期不代表设备内镜像版本；未连接真机验证。
> 升级流程的逐步交互序列见 [OTA 流程交互](OTA_FLOW_INTERACTIONS.md)。

## 源码文件别名

| 别名 | 路径（相对源码根目录） | 角色 |
|---|---|---|
| WA | `MCU_Master_W515PIQ6_APP/BSP/boot_sdk/app_upgrade/upgrade_service.c` | W515 APP 命令处理 |
| WB | `MCU_Master_W515PIQ6_IAP/Template/boot_sdk_w515/Core/Src/bootloader.c` | W515 Boot 命令处理 |
| WP | `MCU_Master_W515PIQ6_IAP/Template/boot_sdk_w515/Core/Src/protocol.c` | W515 Boot 帧解析 |
| WA-def / WP-def | `*/shared/upgrade_protocol_def.h` | 命令/错误码/魔数定义 |
| NA | `MCU_Slave/SeerLib/SystemAPI/MiniModule_SystemConfig.c` | N32 APP 命令处理 |
| NB | `MCU_Slave_Boot_N32/src/main.c` | N32 Boot 命令处理 |
| NI | `MCU_Slave/SeerLib/Src/n32g430_it.c` | N32 字节所有权仲裁 |
| PX | `MCU_Master_W515PIQ6_APP/BSP/boot_sdk/app_upgrade/upgrade_proxy.c` | GLPX/GLPE 代理 |
| RT | `MCU_Master_W515PIQ6_APP/BSP/src/bsp_rangefinder.c` | APP 分发顺序 |
| WP-cfg | `MCU_Master_W515PIQ6_IAP/Template/boot_sdk_w515/product_config.h` | Boot 配置/RTC魔数 |
| WA-cfg | `MCU_Master_W515PIQ6_APP/BSP/boot_sdk/product_config.h` | APP 配置 |

## 0. 通用帧格式

### 0.1 W515 与 N32 升级帧（同一格式）

```text
请求：AA CMD LEN_H LEN_L PAYLOAD... CRC_H CRC_L 55
响应：AA (CMD|0x80) LEN_H LEN_L PAYLOAD... CRC_H CRC_L 55
```

| 维度 | 规则 | 证据 |
|---|---|---|
| SOF/EOF | **AA / 55** | WA-def:15-16 |
| LEN | **BE16**=payload字节数 | WA:77-78, WP:108-109 |
| CRC16 | **Modbus**：初值FFFF、多项式A001；覆盖 CMD+LEN+PAYLOAD（**不含AA/55**）；线上**高字节在前** | WA:52-63,86-88 |
| 响应CMD | 请求CMD **\| 0x80** | WA-def:17, WP-h:30 |
| 最大payload | **1032**（W515 Boot/N32 Boot）；**16**（N32 APP） | WA-def:18, NB:164, NA:10 |
| CRC失败 | **静默丢弃，无响应**（两侧一致） | WA:267, WP:213-221 |

### 0.2 N32 响应与 W515 响应的关键差异

| 维度 | W515 响应 | N32 响应 |
|---|---|---|
| status字节 | **无统一前缀**（ACK类payload[0]=错误码） | **payload[0]恒为status** |
| LEN含义 | payload字节数 | **status+data**（status计入LEN） |
| 证据 | WA:84-92 | NA:95-123, NB:924-951 |

### 0.3 端序总表（易错，逐字段核对）

| 帧内字段 | 端序 | 证据 |
|---|---|---|
| 帧LEN、CRC | **高字节在前** | 同上 |
| W515请求 payload（magic/addr/size/crc） | **大端** | WB:1016-1023 |
| W515 0x02 info48 | **小端** | WA:113-156 |
| W515 0x09 status | **大端** | WB:1263-1284 |
| N32 0x34 帧内地址 | **大端** | NB:1248 |
| N32 0x34 帧内数据字 | **小端** | NB:1281 |
| N32 info（data32/data16） | **大端** | NA:127-145, NB:1131-1140 |

## 1. W515 主控命令（0x01~0x0A, 0xF7）

### 1.1 命令总表

| CMD | 名称 | APP实现 | Boot实现 | 响应CMD |
|---|---|---|---|---|
| 0x01 | 握手 | ✅回APP魔数 | ✅回Boot魔数 | 0x81 |
| 0x02 | GET_INFO | ✅48B info | ✅同结构 | 0x82 |
| 0x03 | ENTER_UPGRADE | ✅跳Boot | ✅进升级态 | 0x83 |
| 0x04 | 擦除 | ❌静默 | ✅ | 0x84 |
| 0x05 | 写入 | ❌静默 | ✅双形态 | 0x85 |
| 0x06 | 校验 | ❌静默 | ✅ | 0x86 |
| 0x07 | 复位 | ✅逻辑重启 | ✅升级成功才放行 | 0x87 |
| 0x08 | EXIT | ❌静默 | ❌回未知命令 | 0x88 |
| 0x09 | GET_STATUS | ❌静默 | ✅49B诊断 | 0x89 |
| 0x0A | ECHO | ❌收不进 | ✅回显 | 0x8A |
| 0xF7 | 业务信息查询 | ❌收不进 | ✅55B | 0xFE(F7帧) |

APP 收不到 0x0A/0xF7 的原因：WA RX 过滤器仅放行 CMD∈0x01..0x09（WA:202-209）。APP 侧 0x04~0x09 落 default **不回复**（WA:173-176）。

### 1.2 0x01 握手

**请求** payload 4B 大端魔数 `UPG_MAGIC_REQ=0x12345678`（WA-def:49）。

**响应** payload 恰 4B 大端：

| 应答方 | payload | 证据 |
|---|---|---|
| APP | `AA 55 AA 55`（0xAA55AA55） | WA:102-108 |
| Boot | `87 65 43 21`（0x87654321） | WB:969-971 |

Boot 分支细节：len<4→`[0x02]`；magic 错→**不回复**（WB:958-976）。⚠️ 源码握手**无状态限制**——VERIFY 成功后再次握手仍被接受（WB:956-978 无任何 s_state 判断）；「VERIFY 后禁止再握手」不在 W515 源码中。

```text
请求        AA 01 00 04 12 34 56 78 34 81 55
应答(Boot)  AA 81 00 04 87 65 43 21 4B B2 55
应答(APP)   AA 81 00 04 AA 55 AA 55 9F F4 55
```
（三个 CRC 均程序验证）

### 1.3 0x02 GET_INFO

请求 LEN=0（两侧均不校验请求负载）。响应 payload=48B info（APP/Boot **同一结构同一数据源**，meta 地址两侧均 0x08008200）：

| 偏移 | 长度 | 字段（LE） | 取值来源 | 证据 |
|---|---|---|---|---|
| 0 | 4 | device_id | uid0^uid1^uid2 @0x1FFFF7E8 | WA:118-122 |
| 4 | 2 | hw_ver | 0x0100 | WA:125,129 |
| 6 | 2 | sw_ver | meta.version 高16位 | WA:126-127 |
| 8 | 2 | boot_ver | 0x0100 | WA:128-131 |
| 10 | 2 | 保留 | 0 | WA:115 |
| 12 | 16 | model | "J57AA-W515" | WA:134 |
| 28 | 4 | flash_size | 0x00200000 | WA:137-138 |
| 32 | 4 | app_start | 0x08008000 | WA:141-142 |
| 36 | 4 | app_max | 0x001F8000 | WA:145-146 |
| 40 | 4 | app_size | meta+0x20，无效→0 | WA:149-153 |
| 44 | 4 | app_crc | meta+0x24，无效→0 | WA:150-154 |

meta 魔数 `FW_META_MAGIC=0x4649524D`("FIRM")；无效时 sw/app_size/app_crc 置 0（WB:429-433）。

```text
请求        AA 02 00 00 00 D0 55
应答模板    AA 82 00 30 [info48] CRC_H CRC_L 55
```

### 1.4 0x03 ENTER_UPGRADE

请求 LEN=0。响应 `[0x00]`。

| 侧 | 回复后行为 | 证据 |
|---|---|---|
| APP | RTC_BKP10=0x00D1234D→PB6保电→**直跳0x08000000** | WA:160-164 |
| Boot | RTC_BKP10=0x00A1234A→STATE_BOOTLOADER_MODE→written_size=0 | WB:993-999 |

```text
请求 AA 03 00 00 C0 81 55
应答 AA 83 00 01 00 30 28 55
```

### 1.5 0x04 擦除

**请求** payload 9B（第9字节可省略，len≥8 即接受）：

| 偏移 | 长度 | 端序 | 含义 | 证据 |
|---|---|---|---|---|
| 0 | 4 | BE | 起始地址 | WB:1016-1019 |
| 4 | 4 | BE | 擦除长度 | WB:1020-1023 |
| 8 | 1 | — | 加密标志（当前编译配置忽略） | WB:1032-1041 |

地址合法性（WB:680-688）：start≥0x08008000 且 <0x08200000；页 4096。响应 `[0x00]`/`[0x02]`len错/`[0x03]`擦除失败。

```text
请求(128KB) AA 04 00 09 08 00 80 00 00 02 00 00 00 52 A2 55
应答OK      AA 84 00 01 00 44 29 55
```

### 1.6 0x05 写入（双形态，自动判别）

判定式 `((LEN-4) & 3)`（WB:1078-1083）：

| 形态 | 布局 | 判定 | ACK |
|---|---|---|---|
| 无ACK | `[addr:4BE][data:N]` | N%4==0 | 错误时才回 |
| 带ACK | `[flag:1][addr:4BE][data:N]` | (LEN-4)%4≠0；ack=flag&1 | 回 ACK |

⚠️ 带ACK形态若 N%4==3 会被误判为无ACK形态（源码启发式真实边界，WB:1080）。

成功时 `written_size+=data_len`；每次写前 RTC_BKP10=APP_PENDING（WB:1066-1067）。flash 约束：addr≥0x08008000、4字节对齐、奇数字补 0xFFFFFFFF 回读校验（WB:728-811）。

```text
请求(带ACK) AA 05 00 09 01 08 00 80 00 11 22 33 44 22 1A 55
请求(无ACK) AA 05 00 08 08 00 80 00 11 22 33 44 7B DF 55
应答OK      AA 85 00 01 00 B8 28 55
```

### 1.7 0x06 校验

**请求** payload 12B 必需+4B 可选：

| 偏移 | 长度 | 端序 | 含义 | 证据 |
|---|---|---|---|---|
| 0 | 4 | BE | 校验地址 | WB:1168-1171 |
| 4 | 4 | BE | 校验长度 | WB:1172-1175 |
| 8 | 4 | BE | 期望CRC32 | WB:1176-1179 |
| 12 | 4 | BE | 新固件版本（仅存诊断，不参与逻辑） | WB:1181-1187,866 |

CRC32 算法：addr==0x08008000 时走 **meta 兼容 CRC**——meta 的 size/crc 两字段（0x08008220~0x08008227）按 0xFF 参与计算；多项式 0xEDB88320、初值 0xFFFFFFFF、末尾取反（WB:813-819,532-560）。

成功→STATE_UPGRADE_SUCCESS + RTC_BKP10=0x00B5678B；CRC 不符或 **meta 三连不符**（magic=="FIRM" && meta.app_size==verify_size && meta.app_crc==verify_crc）→ `[0x06]`（WB:1210-1252）。

```text
请求 AA 06 00 10 08 00 80 00 00 01 00 00 DE AD BE EF 00 01 00 00 00 4C 55
应答OK AA 86 00 01 00 FC 28 55
应答错 AA 86 00 01 06 FE A8 55
```

### 1.8 0x07 复位

| 侧 | 成功路径 | 失败路径 | 证据 |
|---|---|---|---|
| APP | 回0x00→延时→RTC_BKP10=NORMAL_RUN→经Boot回APP | — | WA:166-171 |
| Boot | 仅 `s_state==STATE_UPGRADE_SUCCESS && check_app_valid()`：回0x00→写APP_MAGIC→复位→跳APP | 回0x06，留Boot | WB:1294-1311 |

```text
请求 AA 07 00 00 01 C0 55
应答OK AA 87 00 01 00 00 29 55
应答错 AA 87 00 01 06 02 A9 55
```

### 1.9 0x08 EXIT（定义未实现）

WA-def:30 有定义；Boot 无 case→default 回 `[0x01]` 未知命令（WB:1313-1316）；APP 静默忽略。

```text
请求 AA 08 00 00 02 F0 55
应答Boot AA 88 00 01 01 D4 EB 55
```

### 1.10 0x09 GET_STATUS（49B 诊断）

请求 LEN=0。响应 payload 恒 49B，多字节字段**大端**（WB:1261-1286）：

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 1 | state | boot_state_t 原值 |
| 1 | 4 BE | written_size | 累计写入 |
| 5 | 4 BE | ore_count | USART2 溢出计数 |
| 9 | 1 | verify_result | 00无/01成功/02CRC失败/03meta失败/E1长度失败 |
| 10 | 3 | 保留0 | — |
| 13 | 4 BE | verify count | 校验次数 |
| 17 | 4 BE | verify addr | 最近校验地址 |
| 21 | 4 BE | verify size | 最近校验长度 |
| 25 | 4 BE | expected_crc | 期望 CRC |
| 29 | 4 BE | calculated_crc | 实算 CRC |
| 33 | 4 BE | meta_magic | 0x4649524D |
| 37 | 4 BE | meta_size | meta.app_size |
| 41 | 4 BE | meta_crc | meta.app_crc |
| 45 | 4 BE | elapsed_ms | 校验耗时 |

```text
请求 AA 09 00 00 C2 A1 55
应答(升级成功态) AA 89 00 31 20 00 01 00 00 ... C2 1E 55
```

### 1.11 0x0A ECHO（Boot 专有）

Boot 回显原 payload（WB:1289-1292）；APP 过滤器拒绝（WA:202-209）。

```text
请求 AA 0A 00 02 01 02 90 9D 55
```

### 1.12 0xF7 业务信息查询（Boot 处理）

| 项 | 内容 | 证据 |
|---|---|---|
| 请求 | 固定10B `AA EE F7 00 00 00 00 F7 BB FF`，**无CRC** | WP:21-24,163-191 |
| 响应 | 55B `AA FE F7 30 [info48] [XOR] BB FF`；**响应头第2字节是FE** | WB:467-502 |
| XOR | 覆盖 frame[2..51] | WB:467-502 |
| info48 | 与 0x02 **完全同一结构** | WB:987-991,436-492 |

```text
请求 AA EE F7 00 00 00 00 F7 BB FF
响应 AA FE F7 30 [info48] [XOR] BB FF（全长55B）
```

### 1.13 W515 错误码枚举（ACK payload[0]）

| 值 | 常量 | 实际使用 |
|---|---|---|
| 0x00 | UPG_ERR_NONE | 成功 |
| 0x01 | UPG_ERR_UNKNOWN_CMD | Boot default |
| 0x02 | UPG_ERR_INVALID_PARAM | len/参数错 |
| 0x03 | UPG_ERR_FLASH_FAIL | 擦写失败 |
| 0x04 | UPG_ERR_CRC_FAIL | **定义未使用**（静默丢帧） |
| 0x05 | UPG_ERR_TIMEOUT | **定义未使用** |
| 0x06 | UPG_ERR_VERIFY_FAIL | 校验失败 |

（WA-def:36-42, WP-h:35-41）

## 2. N32 副板命令（0x31~0x39）

### 2.1 命令总表（APP vs Boot 能力）

| CMD | 名称 | APP(NA) | Boot(NB) | 响应CMD |
|---|---|---|---|---|
| 0x31 | 握手 | ✅33B info | ✅17B info | 0xB1 |
| 0x32 | 信息 | ❌→0x01 | ✅同0x31 | 0xB2 |
| 0x33 | 擦除 | ❌→0x01 | ✅ | 0xB3 |
| 0x34 | 写入 | ❌→0x01 | ✅成功默认静默 | 0xB4 |
| 0x35 | 校验 | ❌→0x01 | ✅带16B data | 0xB5 |
| 0x36 | 复位 | ❌→0x01 | ✅**不清RTC magic** | 0xB6 |
| 0x37 | 进APP | ❌→0x01 | ✅ | 0xB7 |
| 0x38 | 进Boot | ✅写BKP10R+复位 | ❌→0x01 | 0xB8 |
| 0x39 | 状态 | ❌→0x01 | ✅62B诊断 | 0xB9 |
| 0x3A | 弹道回显 | ✅（业务，非升级） | ❌→0x01 | 0xBA |
| 0x7F | 帧错误 | 无此概念 | 错误专用→0xFF | 0xFF |

APP 的 switch 仅含 0x31/0x38/0x3A 三个 case（NA:194-237）；其余全落 default→BAD_CMD。

### 2.2 N32 状态码（status 字节）

| 值 | APP 常量 | Boot 常量 | 语义 |
|---|---|---|---|
| 0x00 | OK | ST_OK | 成功 |
| 0x01 | BAD_CMD | ST_BAD_CMD | 未知命令 |
| 0x02 | BAD_LENGTH | ST_BAD_LEN | 长度错误 |
| 0x03 | **BAD_PAYLOAD** | **ST_BAD_RANGE** | **APP=载荷错；Boot=地址/顺序错** |
| 0x04 | BAD_CRC | ST_BAD_CRC | CRC 错 |
| 0x05 | — | ST_FLASH_ERR | 仅Boot |
| 0x06 | — | ST_VERIFY_ERR | 仅Boot |

（NA:14-18 vs NB:43-50）

### 2.3 0x31 握手（双模式通用请求）

**请求** payload="N32B"（4E 33 32 42），LEN=4。APP 要求逐字节匹配；Boot 还接受 LEN=0。

**响应**（status 后首4字节为 magic）：

| 模式 | magic | 后续内容 | 总data |
|---|---|---|---|
| APP | "N32A" | 30B 运行统计（data32） | 33B |
| Boot | "N32B" | 15B Boot信息（data16） | 17B |

**APP data32**（NA:127-145）：

| 偏移 | 字段 | 值/来源 |
|---|---|---|
| 0-3 | magic BE32 | "N32A" |
| 4-5 | APP版本 BE16 | 0x0106 |
| 6-7 | 保留 BE16 | 0 |
| 8-11 | 入口 BE32 | 0x08002000 |
| 12-15 | 保留 BE32 | 0 |
| 16 | 运行阶段 | RangeN32_RuntimeStage |
| 17 | 遗留帧就绪标志 | USART1_RX_flag |
| 18-19 | 遗留帧字节计数 BE16 | USART1_RX_CNT |
| 20-23 | UART1累计RX BE32 | RangeN32_Uart1RxBytes |
| 24-25 | 弹道帧收到 BE16 | BallisticFramesRx |
| 26-27 | 弹道帧已处理 BE16 | BallisticFramesHandled |
| 28-29 | 弹道帧有效 BE16 | BallisticFramesValid |
| 30-31 | 心跳**低16位** BE16 | MainLoopHeartbeat |

**Boot data16**（NB:1131-1140）：

| 偏移 | 字段 | 值 |
|---|---|---|
| 0-3 | magic BE32 | "N32B" |
| 4 | Boot版本（**单字节**） | 0x01 |
| 5-8 | APP起址 BE32 | 0x08002000 |
| 9-12 | APP末址 BE32 | 0x0800F7FF |
| 13-14 | 页大小 BE16 | 0x0800=2048 |
| 15 | 向量有效布尔 | app_valid()?1:0 |

```text
请求(通用)      AA 31 00 04 4E 33 32 42 75 B8 55
应答Boot(有效)  AA B1 00 11 00 4E 33 32 42 01 08 00 20 00 08 00 F7 FF 08 00 01 49 58 55
应答APP(零计数) AA B1 00 21 00 4E 33 32 41 01 06 00 00 08 00 20 00 ... 39 2E 55
```

### 2.4 0x33 擦除（Boot）

**请求** payload 14B：magic("N32B") + addr BE32（页对齐）+ size BE32 + 页大小 BE16（**必须0x0800**）。响应 `[status]`；成功清零全部升级诊断计数（NB:1204-1216）。

```text
请求(擦8KB) AA 33 00 0E 4E 33 32 42 08 00 20 00 00 00 20 00 08 00 FA 78 55
应答OK     AA B3 00 01 00 30 27 55
```

### 2.5 0x34 写入（Boot，双形态+顺序锁）

判定式同 W515：`((len-4) & 3)`（NB:1238-1241）。带ACK形态 `[flag:1][addr:4BE][data:N]`。

| 约束 | 规则 | 证据 |
|---|---|---|
| 顺序 | addr 必须等于 `APP_BASE + dbg_boot_written_size` | NB:1257-1258 |
| 重复写 | addr<expected 且内容逐字节匹配→仅计数，**默认无响应** | NB:1259-1270 |
| 跳写 | →0x03 | NB:1271-1276 |
| 覆写非空白 | `current != 0xFFFFFFFF` →0x05 | NB:1283-1289 |
| 端序 | **地址大端、数据字小端** | NB:1248,1281 |
| ACK | 成功且未置ACK位→**不回帧** | NB:39-41,1303-1305 |

```text
请求(带ACK) AA 34 00 0D 01 08 00 20 00 00 40 00 20 C5 21 00 08 DD EB 55
应答OK     AA B4 00 01 00 44 26 55
```

### 2.6 0x35 校验（Boot，响应带16B诊断）

**请求** payload 16B：magic + addr BE32 + size BE32 + 期望CRC32 BE32（初值FFFFFFFF、多项式EDB88320、末尾取反，NB:341-364）。

**响应** 0xB5 带 status + 16B：addr/size/expected/actual 各 BE32（NB:1341-1344）。

```text
请求(全FF区8KB,CRC=B4293435) AA 35 00 10 4E 33 32 42 08 00 20 00 00 00 20 00 B4 29 34 35 E2 61 55
通过响应 AA B5 00 11 00 08 00 20 00 00 00 20 00 B4 29 34 35 B4 29 34 35 CB DA 55
```

### 2.7 0x36 复位（Boot）

请求 LEN=0 或 "N32B"。回 0xB6+0x00 → NVIC_SystemReset()。⚠️ **不清 RTC->BKP10R**：若 magic 残留（如刚 0x38 过），复位后仍停留 Boot；只有 jump_to_app 才清（NB:461-465,478）。

```text
请求 AA 36 00 00 CE 91 55
应答 AA B6 00 01 00 FC 27 55
```

### 2.8 0x37 进APP（Boot）

请求 LEN=0 或 "N32B"。app_valid→回0x00→`jump_to_app()`（清BKP10R→关中断→VTOR=APP_BASE→MSP→跳转，NB:468-490）；无效→回0x03。

```text
请求 AA 37 00 00 0E C0 55
应答 AA B7 00 01 00 00 26 55
```

### 2.9 0x38 进Boot（APP）

**请求** payload="N32A"（4E 33 32 41），LEN 必须=4。APP 处理顺序（NA:210-214）：①解除弹道回显→②回 0xB8+0x00+**回显payload**→③写 RTC->BKP10R="N32B"→复位。

```text
请求 AA 38 00 04 4E 33 32 41 74 61 55
应答 AA B8 00 05 00 4E 33 32 41 FB 78 55
```

副作用：复位后 Boot 的 stay_boot=1 **直接永久停留**（NB:1468-1472）。

### 2.10 0x39 状态（Boot，62B 诊断）

请求**无任何校验**（NB:1410-1412）。响应 0xB9+0x00+62B（NB:1142-1166）：

| 偏移 | 字段 | 偏移 | 字段 |
|---|---|---|---|
| 0-3 | 已写字节数 | 32-35 | 校验期望CRC32 |
| 4-7 | 最近写地址 | 36-39 | 校验实际CRC32 |
| 8-11 | 最近写长度 | 40-43 | 写间隙计数 |
| 12-15 | RX中断计数 | 44-47 | 重复写计数 |
| 16-19 | RX溢出计数 | 48 | 最近命令 |
| 20-23 | RX错误计数 | 49 | 最近status |
| 24-27 | 最近校验地址 | 50 | 最近写status |
| 28-31 | 最近校验大小 | 51 | 最近校验status |
| 52-55 | RX累计字节 | 56-57 | dbg帧长BE16 |
| 58-59 | payload_len BE16 | 60 | rx_result |
| 61 | 最后RX字节 | | |

## 3. GLPX / GLPE 代理通道

（本节由代理提取任务补充——占位，待 GLPX 提取完成后填充）

## 4. 已核对的易错点汇总

| # | 坑 | 证据 |
|---|---|---|
| 1 | W515 APP 收 0x04~0x09 **静默不回**，等待会超时 | WA:173-176 |
| 2 | N32 响应 LEN **含 status**；W515 不含 | NA:99, NB:927 |
| 3 | N32 0x03 状态码语义按模式分裂 | NA:17, NB:47 |
| 4 | N32 0x34 地址大端/数据小端混用 | NB:1248,1281 |
| 5 | N32 0x34 成功默认无响应 | NB:39-41,1303-1305 |
| 6 | N32 0x36 复位不清 RTC magic | NB:461-465 |
| 7 | W515 0x05 带ACK形态 N%4==3 时误判 | WB:1080 |
| 8 | W515 握手响应魔数**大端**、info48**小端** | WA:102-108,113-156 |
| 9 | W515 CRC 错**静默丢帧**（不发 0x04 错误码） | WA:267, WP:213-221 |
| 10 | Boot 版本在 N32 data16 中是**单字节** | NB:1134 |
| 11 | W515 0x06 对 0x08008000 用 meta 兼容 CRC（size/crc 两字段按 0xFF 算） | WB:813-819 |
| 12 | N32 APP 心跳@30 仅低16位（截断） | NA:145 |

## 5. 不确定项/缺口（如实声明）

- 上位机是否总发 0x04 第9字节：固件侧无约束（当前编译忽略该字节）。
- `UPG_RAM_FLAG_VALUE=0xDEADBEEF` 在两工程 .c 中零引用，为遗留常量。
- `RangeN32_RuntimeStage` 在 NA 内无赋值点，取值含义需查工程其它文件。
- 设备内实际镜像是否与本源码快照一致：未验证（无真机连接）。
