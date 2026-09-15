# Boot 版本可查询改造（固件侧 patch 说明）

> 目标：APP 模式下 F7 上报的 Boot 版本从「编译期常量」改为「读 Boot flash 真实值」。
> 协议零改动（F7 帧 `info@8` 仍是 u16）。上位机已按新规则显示，两版固件均可兼容。

## 改动一：Boot 工程（MCU_Master_W515PIQ6_IAP）

### 1. 版本升号 — `Template/boot_sdk_w515/product_config.h:84`

```c
#define BOOTLOADER_VERSION              0x0101U   // 0x0100 -> 0x0101（每次 Boot 改动 +1）
```

### 2. 嵌入固定地址版本块 — 新文件 `boot_version.c`（加入 Keil 工程）

```c
#include <stdint.h>
#include "product_config.h"

#define BOOT_VER_MAGIC   0x5654424AU  /* "JBVT" */
#define BOOT_VER_ADDR    0x08007FF0U  /* Boot 区尾部（FL_APP_ADDR-16，主控 BOOT_SIZE=32KB） */

typedef struct {
    uint32_t magic;
    uint16_t version;      /* = BOOTLOADER_VERSION */
    uint16_t build_seq;    /* 每次烧写人工 +1 */
    uint32_t date_code;    /* YYYYMMDD */
    uint16_t crc16;        /* 对前 12 字节 CRC16-Modbus */
    uint16_t reserved;
} __attribute__((packed)) boot_ver_info_t;

/* Keil AC6: 配合 scatter 定位；或直接 __attribute__((at(BOOT_VER_ADDR))) */
const boot_ver_info_t g_boot_ver_info __attribute__((section(".bootver"), used)) = {
    BOOT_VER_MAGIC, BOOTLOADER_VERSION, 1, 20260828, 0, 0
};
```

### 3. Scatter 文件（.sct）加一个域

```
ER_BOOTVER 0x08007FF0 0x10 {
    *(.bootver)
}
```

> bin 会填充到 ~32KB（0x7FF0+16），Boot 区正好 32KB，放得下。
> crc16 字段可在烧录后由上位机校验（上位机目前只查 magic+version，crc16 为预留）。

## 改动二：APP 工程（MCU_Master_W515PIQ6_APP）

### 1. 版本号同步 — `BSP/boot_sdk/product_config.h:30`

```c
#define BOOTLOADER_VERSION              0x0101U   /* 与 Boot 工程保持一致 */
```

### 2. F7 读真实 Boot — `Template/gd32w51x_it.c:429` 替换

```c
/* 原: f7_put_u16(info, 8U, (uint16_t)BOOTLOADER_VERSION); */
f7_put_u16(info, 8U, f7_real_boot_version());

/* 新增（gd32w51x_it.c 内）: */
#include <stdint.h>
#define BOOT_VER_MAGIC 0x5654424AU

static uint16_t f7_real_boot_version(void)
{
    /* Boot 区尾部固定地址的版本块（Boot 工程嵌入；旧 Boot 无此块则回退编译期值） */
    volatile const uint32_t *p = (volatile const uint32_t *)0x08007FF0U;
    if (p[0] == BOOT_VER_MAGIC) {
        volatile const uint16_t *v = (volatile const uint16_t *)&p[1];
        return v[0];
    }
    return (uint16_t)BOOTLOADER_VERSION;  /* 旧 Boot 兜底 */
}
```

## 上位机显示规则（已实现，无需再改）

| F7 boot_ver | 显示 | 含义 |
|---|---|---|
| `0x0100`（1.0） | Boot(编译期) 1.0 | 旧 Boot，值为 APP 编译期抄录 |
| `> 0x0100`（1.1+） | Boot 1.1 | 新 Boot 真实版本（读自 flash 嵌入块） |
| 主控=Boot 模式 | Boot 1.1 | 0x02 直报，天然真实 |

## 烧录顺序

1. 改两处 `BOOTLOADER_VERSION` → 各自重编译
2. ST-Link 烧 Boot（带嵌入块的新 bin，~32KB）
3. 网页升级 APP（或 ST-Link）
4. 检测 → 主控卡应显示 `Boot 1.1`（不带"编译期"标注）= 改造生效

## N32 副板：无需改动

0x31 已双向可查：Boot 模式报 `bootVersion`、APP 模式报 `appVersion`，上位机已显示。
