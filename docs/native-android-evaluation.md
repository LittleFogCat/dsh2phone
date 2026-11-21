# 冷启动评估：要不要从 WebView 壳转成 native Android？

> 日期：2026-11-20（2026-11-21 补真机 + 公网链路实测）
> 结论：**现在不转**。先开 gzip（公网 20s→6–7s），再考虑首屏瘦身与启动路径；
> 如果之后仍需要 1–2 秒级冷启动，再做「原生快车道」（只接管会话列表/阅读/发送/审批），
> 而不是重写整个 DSH 客户端。

## 1. 一句话结论

- 冷启动要分两种链路看，瓶颈完全不同：
  - **局域网内是 CPU/JS 瓶颈**：真机实测约 **3 秒**（与桌面 2x CPU 的 4.2s 同量级）。
  - **公网是带宽瓶颈**：真机实测约 **20 秒**；多出来的 ~17 秒不是 JS 慢，而是
    **10.2 MB 未压缩 JS ÷ 服务器出口 ~4 Mbps**。
- 公网服务器出口实测只有 **3.4–4.9 Mbps**（下载 2.39 MB 的 APK）；
  10.2 MB 需要 18–25 秒，与真机 20 秒完全吻合。
- 公网 nginx **没有压缩 JS**：同域主站的 `/assets/index-*.js`（727 KB）原样下发，
  `content-encoding` 为空；`/dsh/` 走同一个 nginx，同样不压缩。
- 壳（Activity、WebView 初始化、局域网探测）合计约 **1–2 秒**，不是主要矛盾。
- 转 native 能把公网下载量从 10.2 MB 降到 ~0.1–1 MB（只下 JSON），确实能到 1–2 秒；
  但代价是重写 DSH 的手机 UI 与一套非公开协议，按最小可用估算 **10–14 人周**。
- 更划算的顺序：**开 gzip（0.5 天，公网 20s→6–7s）→ 只预取 immediate 模块
  （1–2 周，公网→4–5s）→ 启动路径优化（2–3 天，局域网 3s→2s）**。

## 2. 测量方法

- 环境：Windows / Ryzen 7 5700X（桌面 CPU）；Playwright + Edge（Chromium 内核，与 Android
  WebView 同源）；`Emulation.setCPUThrottlingRate` 模拟手机 CPU；CDP 网络限速模拟蜂窝。
- 入口：`http://127.0.0.1:43120/`（本机 DSH，0.2.2-rc.3），用 `tunnel/src/dsh-cookie.mjs`
  铸 cookie，与手机进 `/dsh/` 后的页面完全一致。
- 指标：FCP、`loadEventEnd`、**页面出现可输入的 composer**（真正“能用”的时刻）、
  主线程 long task 总和、传输字节。
- CPU 倍率与真机不是严格换算：1x≈桌面，2x≈旗舰手机，4x≈中端，6x≈低端/老机器；
  看数量级与相对占比，不要看绝对值。同场景跑多次会有 ±10% 波动。
- 这些回环测试只回答“CPU/JS 占多少”；公网的真实瓶颈看 §3.1（真机 + 服务器出口带宽实测）。

## 3. 实测结果

| # | 场景 | FCP | 可输入 | load | 传输 | 主线程 long task |
|---|---|---|---|---|---|---|
| 1 | 桌面基准（1x，本机） | 0.32s | **1.6s** | 1.1s | 10.5 MB | 1.0s |
| 2 | 旗舰近似（2x，本机） | 0.49s | **4.2s** | 2.7s | 10.2 MB | 3.4s |
| 3 | 中端（4x，本机） | 0.56s | **8.0–9.1s** | 6.0s | 10.2 MB | 8.1s |
| 4 | 中端二次启动（4x，保留磁盘缓存） | 0.33s | **6.9–7.4s** | 4.2s | 0.24 MB | 6.1s |
| 5 | 中端 + 4G（4x，12 Mbps / 80 ms） | 3.3s | **14.8s** | 11.8s | 10.2 MB | 8.2s |
| 6 | 低端（6x，本机） | 1.1s | **15.7s** | 10.4s | 10.2 MB | 14.2s |

读法：

- 第 1 行就是「桌面浏览器打开 DSH」的极限——1.6 秒。也就是说**即使壳完全不存在**，
  页面本身也要 1.6 秒；手机 CPU 慢 2–6 倍后就是 4–16 秒。
- 第 4 行是“日常第二次冷启动”（WebView 磁盘缓存还在，只重新校验 0.24 MB）：
  仍然要 6.9–7.4 秒，说明**瓶颈在执行，不在下载**。
- 第 5 行是“在外面用 4G”：网络把 FCP 推到 3.3 秒，真正可用要 14.8 秒；
  其中约 6–7 秒是 10 MB 未压缩传输，约 8 秒是 JS 执行（两者重叠）。

### 3.1 真机 + 公网链路补测（2026-11-21）

上面的表格全部是 `127.0.0.1` 回环（网络≈0），只用于隔离 CPU；它不代表公网。真机与公网补测：

| 链路 | 真机实测（到可用） | 成本构成 |
|---|---|---|
| 局域网直连 | **约 3s** | JS 执行 + 壳；网络≈0 |
| 公网 4G | **约 20s** | ~3s 客户端 + **~17s 传输** |

公网传输为什么是 17 秒：

- 从公网 origin 下载 2.39 MB 的 APK，实测 **0.40–0.58 MB/s（3.4–4.9 Mbps）**，
  三次数值接近。对照：同一台机器从 npmmirror 下载 3.98 MB 用时 0.96s（**34.7 Mbps**），
  排除本机下行限制——这就是服务器出口带宽的上限。
- 10.2 MB ÷ 0.4–0.58 MB/s = **18–25 秒**，与真机 20 秒对得上。
- 同一 nginx 的主站 JS `/assets/index-*.js` 727 KB **没有 `content-encoding`**，
  CSS 68 KB 也没有；说明 `gzip_types` 没包含 JS/CSS。`/dsh/` 走同一个 nginx，同样原样下发。
- 结论：公网这条链路，**瓶颈 = 服务器出口 ~4 Mbps × 未压缩 10.2 MB**，
  不是 WebView、不是 JS 执行、也不是手机 CPU。


### 3.2 页面为什么这么重

- 80 个客户端模块：`@deepseek-ai/dsh-*` 约 70 个 + `dsh2phone` / `dsh-desktop-next` /
  `dsh-opencode-warm` / 皮肤 / 会话日志等第三方模块。
- 模块总量 **8.1 MB**，主应用 `index + vendor + css` **约 2.1 MB**，合计约 10.2 MB。
- 只有 **12 个模块是 `immediately`**（合计 1.6 MB），但 HTML 用 `<link rel=modulepreload>`
  把 **全部 80 个**都预取了；其中两个合并 bundle 就有 5.5 MB 与 2.5 MB。
- 本机 DSH 直连响应没有 Content-Encoding；公网 nginx 已确认也没有（见 §3.1），
  所以 10.2 MB 是原样过公网的。
- `/assets/index-*.js` 是 `Cache-Control: no-cache`（每次冷启动都要 304 校验），
  插件 bundle 带 `?rev=` 且已经是 `immutable`。
- CPU profile（4x）：主应用 `index.js` 约 2.7s、插件 gateway/文件模块约 1.9s、
  `dsh-client-modules` 约 1.2s、GC 约 1.6–2.4s；最大的单个 long task **4.2s**。

## 4. 壳到底占多少

App 侧代码（`mobile/android`）的关键路径：

1. `MainActivity` 原生主页：快，冷启动主要是 Android 启动 + Material 布局，
   经验值约 0.3–0.6s；但**不自动进入**，要用户再点一次「进入 DSH」。
2. `WebAppActivity.onCreate`：先创建 WebView（Chromium 初始化经验值 0.3–0.8s），
   然后 **等 `LanDirect.resolve()` 做完才 `loadUrl`**。
3. `LanDirect.resolve` 预算：缓存快探 500ms + 候选探测 800ms + 向 relay 查询 2500ms；
   蜂窝下 `fetchInfo` 用 `Connection: close`（每次新建 TLS），通常 0.3–0.6s，
   relay 慢时最坏 2.5s——这段时间页面**一个字节都没开始下载**。
4. 页面开始加载后：TLS + relay/直连 RTT + HTML，约 0.2–0.5s（局域网直连更快）。

合计：**约 1–2 秒**（最坏 3 秒）。相比 3 秒（局域网）/ 20 秒（公网）的页面启动，
壳不是主因；但它是唯一能靠 App 侧代码消掉的一段，局域网场景 ROI 很高。

## 5. 三条路线

| | A. 保留 WebView + 优化（推荐） | B. 混合：原生快车道 + WebView 兜底 | C. 全量 native |
|---|---|---|---|
| 冷启动（预计） | 局域网 2–3s；公网 4–7s（P0+P2 后） | 覆盖的流程 1–2s；其它同 A | 局域网 1–2s；公网 2–3s |
| 功能覆盖 | 100%（就是 DSH 本身） | 会话/阅读/发送/审批 ≈ 60–80% | 需重做 80 个模块的 UI |
| 工作量 | 1–3 周 | 4–8 周 | 10–14 周起，长期跟进 |
| 主要风险 | 受 DSH 首屏代码限制，可能停在 3–4s | 两套 UI/两套状态，边界复杂 | 协议非公开、DSH 升级回归、功能永远落后 |
| 适合 | 自用、要完整 GUI | 想要“秒开”且能接受部分功能回 WebView | 产品化、有稳定 API/团队 |

## 6. 推荐路线：保留 WebView，按 ROI 做三件事

### 性价比排序（如果只能做一件事）

1. **gzip**：0.5 天，公网 20s → 6–7s，零维护。**第一刀。**
2. **缓存核查**：如果“每次冷启动”都重新下 10 MB，说明 WebView 磁盘缓存没生效；
   修好缓存可能再省 10s+，半天。先量一次第二次冷启动的传输量再决定。
3. **瘦身**：1–2 周，6–7s → 4–5s，同时把局域网 3s → 2–2.5s。
   前提是能改 DSH 的 boot HTML / 启动图；改不了这条就不存在。
4. **启动路径**：2–3 天，局域网 3s → 2s。
5. **native**：10–14 周，公网 1–3s；瘦身是它 1/10 的成本拿 ~80% 的收益。

为什么瘦身不是第一刀：瘦身单独做（不压缩）3.5 MB ÷ 4 Mbps ≈ 7–9s；
gzip 单独做 2.9 MB ≈ 6–7s；两者叠加才是 4–5s。gzip 先拿大头，瘦身再拿剩下的 2 秒。

### P0 传输层（已上线，2026-11-21）

- 服务器 `conf/nginx/nginx.conf` 的 http 块已启用 gzip（备份 `nginx.conf.bak-20261121-gzip`）：
  `gzip on; gzip_vary on; gzip_proxied any; gzip_comp_level 5; gzip_min_length 1024;`
  `gzip_types` 含 `text/css`、`text/javascript`、`application/javascript`、`application/json`、
  `application/manifest+json`、`image/svg+xml`。
- 实测：主站 JS `727,637 B` → 线上 `207,103 B`（**3.5x**）；`/dsh/` 的 10.2 MB 线上约 **2.9 MB**，
  按服务器出口 4 Mbps 约 **6 秒**（之前 20 秒）。
- 验证：`node tools/public-link-check.mjs`（改完重跑，看 `content-encoding=gzip` 与线上字节）。
- 待确认：公网 `/dsh/` 是 proxy 路径且 `proxy_buffering off`，需用真机打开一次，
  从 nginx 日志的 `body_bytes_sent` 确认实际传输量（见 §9）。

- 后续（可选）：`/dsh/assets/*` 加 `Cache-Control: public, max-age=31536000, immutable`
  （插件 bundle 已是 immutable）；确认 443 是否 HTTP/2。带宽受限时这两项收益小于压缩本身。

### P1 启动路径（2–3 天，第三优先，主要改善局域网体感）

- 已配对时**启动即进入 WebView**（主页退化为返回键/菜单可达），省掉一次点击和主页等待。
- 进页面前**不要阻塞等局域网探测**：先按公网 `loadUrl`，LAN 探测并行跑；
  命中且页面还没 commit 时再切直连，否则下次进入生效。
- `fetchInfo` 去掉 `Connection: close`（复用连接），或把预算压到 ~800ms。
- 更新检查挪到 `onPageFinished` 之后（现在主页 resume 就发，和首屏抢带宽）。
- 可选：退出后保留进程/WebView 的「保温窗口」（前台服务 10–30 分钟），
  窗口内再进是秒开；代价是常驻内存与耗电，需你拍板。
- 预期：**−1~2s**（蜂窝下更明显）。

### P2 DSH 首屏瘦身（1–2 周，第二优先，收益最大但改的是 DSH）

- 先确认非 `immediately` 模块是否真的按需激活；如果是，只预取 12 个 immediate 模块
  （1.6 MB），其余等页面打开对应 UI 再拉：首包可从 10.2 MB 降到约 3.5 MB。
  若 boot 阶段本来就会 import 全部模块，这条收益有限，要连启动图一起改。
- 移动端 UA/开关下跳过桌面专属模块（终端、浏览器预览、插件管理、轨迹、工作流等）。
- 首屏只 hydrate「会话列表 + 当前会话最近 N 条」，历史消息分页。
- 插件 bundle 做 minify/压缩（现在单个模块 1.1 MB / 0.69 MB）。
- 预期：首包 10.2 MB → 3.5 MB（gzip 后约 1 MB）；公网在 P0 基础上再降到 **4–5s**，
  局域网 CPU 也会少 1–2s。

三件事做完仍不满足，再进入 B/C。

## 7. 如果一定要 native：先把账算清

### 7.1 能复用 / 必须重写

- 可复用（已经是原生）：`PairUrl` / `SetCookie` / `PairingClient` / `SecurePrefs` /
  `LanDirect` / `UpdateManager` / 扫码与证书策略。
- 必须重写：会话列表与项目树、消息流与流式增量、Markdown/代码高亮、工具调用卡片
  （bash/read/write/diff/search…）、审批与提问、模型选择、附件上传、工作区文件/预览、
  终端、设置、插件 UI、深色/主题、i18n、返回键语义。
- 协议：Web 侧是 `POST /api/*` + `WS /api/remote.mux`（Typert Remote，非公开契约）。
  仓库 `docs/HANDOFF.md` 坑 10 已记录：DSH 升级时 API 可能变化，插件要靠结构探测降级；
  原生客户端没有 JS 的运行时探测能力，回归风险更高。

### 7.2 现成参考

[Agents Anywhere](https://github.com/anywhere-labs/Agents-Anywhere) 的 Android 客户端是
Kotlin + Jetpack Compose + Material 3 的原生实现，覆盖会话、审批、文件、终端，
但它连的是 **AA Server（PostgreSQL + Redis）+ dsh-bridge-next 插件**，不是直连 DSH。
如果目标是“要一个原生手机端”，复用/参考它比从零重写更现实；
代价是多一套服务端与账号体系（服务器 1.6 GB 内存需评估，见 `docs/proposal.md`）。

### 7.3 估算

- 只做「会话列表 + 阅读 + 发送 + 审批」的快车道：**4–8 周**，可覆盖日常 60–80% 操作；
  文件/终端/设置继续走 WebView。
- 全量 parity：**10–14 周起**，之后每次 DSH 升级都要跟。
- 公网收益：原生只下 JSON（会话列表 86 KB + 消息，按 0.1–1 MB 估），
  4 Mbps 下约 0.2–2s；端到端约 **1–3s**，比优化后的 WebView 再快 2–3 秒。

## 8. 决策建议

1. **现在不转全量 native**；先做 P0（公网收益最大），再按 P2 → P1 做
   （P2 需要能改 DSH 客户端；改不了就只做 P0+P1）。
2. P0+P1 完成后重新测一次冷启动（同样的脚本，换真机 4G/局域网各一次）。
3. 出现以下任一情况再启动 native：
   - P0–P2 做完仍 >5 秒，且你每天都被它影响；
   - DSH 官方提供稳定的移动 API / 协议文档；
   - 这个 App 要产品化/上架，性能成为卖点。
4. 启动 native 时**先做快车道**（会话列表/阅读/发送/审批），保留 WebView 兜底，
   不要一次性重写全部 80 个模块。

## 9. 复现

```powershell
node tools/public-link-check.mjs                                     # 公网出口带宽 + JS 是否 gzip（只读）
node tools/public-traffic-check.mjs --minutes 10                     # 真机冷启动后：这次实际下了多少 MB
node tools/mobile-coldstart.mjs --cpu 4                              # 中端 CPU，本机网络
node tools/mobile-coldstart.mjs --cpu 4 --rtt 80 --down 12000        # 中端 CPU + 4G
node tools/mobile-coldstart.mjs --cpu 4 --persistent --runs 2         # 首次 + 二次冷启动
node tools/mobile-coldstart.mjs --cpu 2                              # 旗舰近似
```

真机细粒度计时（debug 包，仅 debug 生效）：

```powershell
# debug 与 release 签名不同，需先卸载 release（会清配对，重新扫码即可）
adb uninstall tech.xiaoniu.dsh2phone
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
# 打开 App 进 DSH，然后：
adb logcat -s Dsh2PhonePerf
# 输出示例：pageFinished +4210ms {"transferKb":2890,"decodedKb":10240,"cached":12,...}
```

工具只测本机 DSH（`http://127.0.0.1:43120`），cookie 由 `tunnel/src/dsh-cookie.mjs` 铸造；
公网 origin 的 device cookie 不在脚本范围内。`public-link-check` 是只读的，输出里把域名
打成 `<PUBLIC_ORIGIN>`。CPU profile 归因（`index.js` / 插件 bundle / GC）是一次性脚本，未入库。

> 注意：Playwright 的 CPU 限速只影响渲染主线程，不模拟手机的内存带宽/GC 差异；
> 真机通常比同倍率更慢，方向不变。
