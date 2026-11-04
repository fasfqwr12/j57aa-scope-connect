# 先读我（3 分钟）

这是 **J57AA 枪瞄双板 OTA 上位机**（浏览器网页，纯前端）的交接包。
功能：BLE 检测主控 W515 / 副板 N32 状态 → 选固件 → 升级 APP 并校验。

---

## 包里有什么

| 内容 | 说明 |
|---|---|
| `j57aa-scope-connect/` | 源码快照（对应 tag `handoff-20261104`），含全部文档 |
| `j57aa-scope-connect/docs/HANDOFF.md` | **完整交接说明，请先读这份** |
| `j57aa-scope-connect.bundle` | 完整 git 历史，可当仓库克隆 |
| `SHA256SUMS.txt` | 全部文件校验和，用于确认传输无损 |

克隆历史（想要能提交的仓库就用这个）：

```powershell
git clone j57aa-scope-connect.bundle j57aa-scope-connect
cd j57aa-scope-connect
git remote set-url origin git@github.com:fasfqwr12/j57aa-scope-connect.git
```

---

## 立刻跑起来（不接硬件）

```powershell
cd j57aa-scope-connect
python -m http.server 5188
```

浏览器打开 **http://127.0.0.1:5188/index.html?admin=1&fake=1**
（`admin=1` 和 `fake=1` 两个都要，缺一个仿真设备不出现）

点「固件升级」→「检测双板状态」→ 3 秒左右出双板信息 → 「在线固件库」选 N32 v1.6 → 右卡应显示 `34940B / 0xFC66B04A`。

---

## 线上地址

https://fasfqwr12.github.io/j57aa-scope-connect/
（GitHub Pages 直接吃 `main` 分支，push 后 1～2 分钟生效，没有 CI）

---

## 三条最容易踩的坑

1. **改代码没效果** → 漏了缓存版本链：改任何 js/css 都要 bump 引用处的 `?v=`，一路升到 `index.html` 的 `app.js?v=`。
2. **仿真模式没反应** → 只写了 `?fake=1`，必须 `?admin=1&fake=1`。
3. **刷 Boot 不归这个工具** → Boot 只能 Keil + ST-Link；且 APP 换新镜像头前必须先把 Boot 升级，否则校验 `ERR_VERIFY_FAIL`。

其余（协议、镜像头、CRC 双口径、发版、待办、权限）都在 `docs/HANDOFF.md`。

---

## 本机上还有两个东西（不在这个包里）

| 东西 | 位置 | 用途 |
|---|---|---|
| 上位机 unified-tool | `E:\phase1\debug_toll\unified-tool` | 本地 Bridge（8766）、工位工具；仓库 `fasfqwr12/unified-tool` |
| J57AA 工具脚本 | `E:\tof\qiangmiao\data\J57AACode_20260507\J57AACode_20260507\tool` | 老 BLE console（9000）、编译后处理、烧录脚本 |

上位机启动：双击该目录下 `启动上位机-测距.cmd`（端口 `127.0.0.1:8766`），停止用 `停止上位机-测距.cmd`。**网页做 OTA 不需要上位机**，它只是开发兜底。

---

## 建议的接手顺序

1. 读 `docs/HANDOFF.md` 第 1～4 节，跑通仿真 + 真机各一次；
2. 照第 11 节的「8 步自检清单」逐条打勾；
3. 看第 10 节待办，确认下一步是固件侧（统一镜像头）还是上位机侧。
