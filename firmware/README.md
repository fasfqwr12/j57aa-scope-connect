# firmware/ 公开候选固件库

网页“升级”页从本目录读取 `versions.json`。点选条目只下载、校验并选中文件；**不会直接刷写**。必须先检测双板状态，再明确确认 W515 APP 升级。

## 发布规则

1. 只放已获准公开的镜像；仓库和 GitHub Pages 均为公开访问。
2. OTA 候选清单允许 `target: "w515-app"` 与 `target: "n32-app"`（副板经主控代理通道刷写）；Boot 镜像不进候选清单，仅存档（URL 可直接下载），Boot 只能用 Keil + ST-Link 烧写。
3. 文件名只能是本目录的安全文件名，不允许路径、URL 或 `..`。
4. `size` 必须是原始下载文件的准确字节数；`sha256` 必填，64位十六进制。
5. `fileCrc32` 是整文件 CRC32；`metaCrc32` 是 W515 元数据兼容 CRC32，二者不可混用。
6. `version`、`date`、`notes` 用于说明来源，不作为“最新”或真机验收的证明；未验收时保持 `recommended: false`。
7. 先运行离线测试，再提交发布；GitHub Pages 的完成时间需实际核验，不承诺固定分钟数。

## 当前候选（仅保留最新两个）

- `W515_APP_20260918.bin`：主控 W515 APP v0.2，64560 字节；SHA-256 `0a06327583a7aa9ecfe5264f14c20646cec93dfe62fbe4e2da4e044353a454c4`；整文件 CRC32 `1174E156`；元数据兼容 CRC32 `E3884829`。
- `N32-APP-v1.7.0-20260918.hex`：副板 N32G430 APP v1.7，Intel HEX，数据 34940B @0x08002000；SHA-256 `51d04b6dc4709dfad63b83f12679d19ca1bd95405ddc99c0b77e4027d9419383`；整文件 CRC32 `0B6044AE`。
- 两者均为 2026-09-18 构建，**待真机验证**（`recommended: true` 仅表示清单里的默认推荐项）。

## 存档镜像（不在 OTA 候选清单）

- `W515_BOOT_20260804.bin`：主控 Boot 存档，12272B；SHA-256 `74af9cd9e36b87c15f71bda6feb94c7e3a50e6fd9d7977bdaebb680a50bbe65f`、CRC32 `71BEDF62`。Boot 不经网页刷写，只能用 Keil + ST-Link 烧写。

## 使用入口

- [升级操作指南](../docs/UPGRADE_GUIDE.md)。
- [当前固件协议与证据](../docs/CURRENT_FIRMWARE_OTA.md)。
- [候选清单](versions.json)。

哈希与文件同源发布，只能检出损坏或清单不一致，不构成独立固件签名验证。网页尚无 service worker，不承诺断网冷启动或离线固件库。
