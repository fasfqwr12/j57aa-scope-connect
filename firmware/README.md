# firmware/ 固件在线库

网页 App「升级」页会 fetch `versions.json`，把 `files` 里登记的固件显示为在线可升级列表（点选即下载固件并升级，不用电脑传文件）。

## 用法

1. 固件 bin 放到本目录（命名规范见 `docs/UPGRADE_GUIDE.md` §1）：
   - `W515_APP_v1.2.3_0715.bin`（主控 APP）
   - `N32_APP_v1.0.4_0715.bin`（测距板 APP）
   - `W515_BOOT_v2.0.0.bin` / `N32_BOOT_v1.1.0.bin`（Boot，仅存档，不能 OTA）
2. 在 `versions.json` 的 `files` 数组登记：

```json
{
  "name": "W515_APP_v1.2.3_0715.bin",
  "target": "w515-app",
  "version": "1.2.3",
  "date": "2026-07-15",
  "size": 110592,
  "crc32": "0AB12CD0",
  "notes": "修复 HUD 角度抖动",
  "recommended": true
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| name | ✓ | 文件名（相对本目录） |
| target | ✓ | `w515-app` / `n32-app`（Boot 文件不登记） |
| version | ✓ | 版本号，显示用 |
| notes | | 更新说明 |
| recommended | | true = 标记推荐 |
| size/crc32 | | 参考信息，下载后工具按固件元数据为准 |

3. commit + push 后 1~2 分钟生效（GitHub Pages）。

## 注意

- 固件内部 0x200 元数据才是升级识别的最终依据，本清单只是入口。
- 敏感/未发布固件不要放这里（仓库是公开的）。
