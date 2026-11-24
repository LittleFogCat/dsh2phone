# 更新日志

本文件记录 **dsh2phone 插件**（`dsh2phone-dsh-plugin`）的版本变化。版本号同时写入
`dsh2phone-dsh-plugin/package.json` 与根 `package.json`。

**规则：每次推送前必须升级版本号**，由 `tools/version-check.mjs` 在 pre-push 阶段强制检查
（安装钩子：`npm run prepare`，或直接 `node tools/install-git-hooks.mjs`）。
升级用 `node tools/version.mjs bump <major|minor|patch>`，它会同时更新版本号并在此文件插入条目。

版本号语义（判断标准见 [AGENTS.md](AGENTS.md#版本管理强制)）：

- **major** — 已配对设备或部署需要人工干预：cookie 格式变了、relay 协议不兼容、配置键重命名/删除、patch 行或目录结构变更导致必须重装。
- **minor** — 新增向后兼容的能力：新标签/新 Remote 方法/新设置项/新的默认行为。
- **patch** — 修复、UI 打磨、依赖升级、文档与工具调整。

## [1.6.6] - 2026-11-24

### 变更

- Android 1.3.5（versionCode 18）release APK 已打出：`mobile/dist/dsh2phone-1.3.5-release.apk`（2 405 197 B，sha256 `ddeb3e2f…`），签名与 1.3.4 同一张证书，可覆盖升级。
- `mobile/dist/latest.json` 更新到 1.3.5 / 18；`mobile/README.md` 的版本号与 manifest 示例同步。
- 构建验证：`:app:assembleRelease`（含 `lintVitalRelease`）通过；`aapt2 dump badging` 为 versionCode 18 / versionName 1.3.5，资源表含 `anim/slide_in_left`、`anim/slide_out_right`，dex 里有 `makeCustomAnimation` 调用。
- 动效手感仍未真机确认（本机 `adb devices` 为空）；release 产物尚未上传服务器，线上 `/dsh2phone/latest.json` 仍是 1.3.4。

## [1.6.5] - 2026-11-24

### 变更

- Android 1.3.5（versionCode 18）：**修正进出 DSH 网页的动效方向**。返回主页原本用 `startActivity(MainActivity, FLAG_ACTIVITY_REORDER_TO_FRONT)`，系统把「把主页提到前台」按 open 转场播放，于是进入（右→左）和退出（同样右→左）方向一致，看着像滑了两遍。
- 现在返回主页改用 `ActivityOptions.makeCustomAnimation(slide_in_left, slide_out_right)`：网页向右整屏滑出、主页从左侧回位（只走 25% 做视差，避免和整屏滑出抢注意力）；新增 `res/anim/slide_in_left.xml`、`res/anim/slide_out_right.xml`（280ms，`decelerate_quint` / `accelerate_quad`）。
- 「不 finish、保留 WebView/页面状态以便下次直接复用」的设计保持不变，只替换这一次过渡的动画；进入方向仍用系统 open。
- 验证：`:app:assembleDebug` + `:app:testDebugUnitTest` 通过（AGP 8.7.3 / Gradle 8.10.2 / JDK 17）。动效手感需真机确认——本机 `adb devices` 为空，未跑 `tools/mobile-e2e.mjs`。

## [1.6.4] - 2026-11-23

### 变更

- Android 1.3.4（versionCode 17）：修复插件 bundle 没进缓存的问题。DSH 的 URL 形如 `/plugins/??pkg/client.js&rev=…`，第一个 `?` 会被 `Uri` 当作 query 分隔符，`getPath()` 只剩 `/plugins/`，导致 1.9 MB 的插件包每次冷启动都重新下载；改为用完整 URL 匹配 `/plugins/??`。
- 设置页「关于」新增**页面缓存大小/文件数**（`页面缓存：2.4 MB · 12 个文件`），复制诊断信息里也带上 `cache=`，便于确认命中情况。
- 实测依据：1.3.3 的 `index.js` 在三次冷启动中只请求了一次（资源缓存已生效），但三个插件 bundle 每次都下载；修复后两者都应命中。
- 验证：`assembleDebug` + `testDebugUnitTest`（43 用例）通过。

## [1.6.3] - 2026-11-23

### 变更

- Android 1.3.3（versionCode 16）：**App 侧静态资源磁盘缓存**。`shouldInterceptRequest` 只拦同 origin 的 `/assets/*`、`/plugins/??*`、图标等静态资源，按完整 URL（含 `rev`）存到 `filesDir/webcache`；DSH 升级 rev 变化自动 miss，30 天 TTL + 64 MB LRU 兜底，解除配对时清空，设置页新增「清除页面缓存」。
- 缓存未命中时由 App 同步抓取（带 cookie、支持 gzip/直连证书锁定），失败/非 200/非静态 MIME 一律回退给 WebView，保证不会因为缓存层白屏。
- 新增 `StaticCacheTest` 4 个用例：读写、超限淘汰、TTL 过期、清空。
- 验证：`:app:assembleDebug`、`:app:testDebugUnitTest` 通过（全部 43 个用例，含新增 4 个）；二次冷启动的实际收益需要真机验证。

## [1.6.2] - 2026-11-23

### 变更

- Android 1.3.2（versionCode 15）：进入 DSH 时显示品牌加载覆盖层（图标 + 「正在进入 DSH…」+ 进度），页面 commit 后淡出；超过 10 秒显示「网络似乎有点慢」和重试按钮，不再出现无反馈白屏。
- 从后台回到前台时 `resumeTimers()` + `invalidate()`，并探测一次 `document.body` 文本；发现空白 surface 时 15 秒内最多自动重载一次。
- 主框架 4xx/5xx/网络错误时隐藏加载层，交给原有的错误横幅/重试逻辑。
- 验证：`:app:assembleDebug` 通过；白屏分支（冷启动慢、后台回来空白）需要在真机上复验。

## [1.6.1] - 2026-11-23

### 变更

- Android 1.3.1：设置页禁用态开关配色，修复无配对时开关看起来仍可点

## [1.6.0] - 2026-11-23

### 变更

- Android 1.3.0（versionCode 13）：**视觉重构**——统一中性灰阶 + 品牌蓝的设计令牌，主页改为「品牌区 + 状态卡 + 主操作」的层级；设置页改为分组卡片 + 图标行 + 开关；配对页改为柔和光晕 + 状态文案；深色模式同步适配。
- 主页已配对时隐藏重复的扫描/步骤入口，重新配对收进卡片内；未配对时保留三步引导。
- 修复更新清单：线上 `dsh2phone/latest.json` 之前停在 1.2.0（versionCode 10），导致 1.2.0 客户端检查更新永远显示“已是最新版”；本次发布 1.3.0（versionCode 13）并同步 APK。
- 保留 1.2.2 的「局域网直连」开关：关闭后同网也强制走公网，便于测试。
- 验证：`:app:assembleDebug`、`:app:assembleRelease`（lintVital/R8）通过；模拟器（Pixel 9 Pro XL API 34）实机截图检查了首页浅色/深色、设置页浅色/深色与已配对/未配对两种状态。

## [1.5.3] - 2026-11-23

### 变更

- Android 1.2.2（versionCode 12）：设置页新增 **「局域网直连」开关**。默认开启；关闭后即使手机和电脑在同一局域网也强制走公网中继，便于验证公网链路或对比两条链路的性能。
- `WebAppActivity` 在 `onResume` 检测开关变化：关闭时立刻从直连切回公网，重新打开时重新做一次直连决策；不需要杀进程。`MainActivity` 的状态探测在开关关闭时也不再做直连探测。
- 验证：`:app:assembleDebug`、`:app:testDebugUnitTest` 通过；真机行为（同网关闭开关后走公网）待复验。

## [1.5.2] - 2026-11-22

### 变更

- **公网 gzip**：服务器 nginx 的 `gzip_types` 补上 JS/CSS/JSON（`gzip_proxied any`、`gzip_comp_level 5`、`gzip_min_length 1024`）；真机实测 `/dsh/` 首次冷启动传输 **2.48 MB**（原 10.2 MB，4.1x），公网冷启动从约 20s 降到约 8s。
- 新增 `tools/public-link-check.mjs`：只读测量服务器出口带宽、静态 JS 的压缩比与线上字节。
- 新增 `tools/public-traffic-check.mjs`：从 nginx 日志汇总一次冷启动实际下载了多少 MB，判断 gzip 与 WebView 缓存是否命中。
- 新增 `tools/mobile-coldstart.mjs`：本机模拟手机 CPU（`--cpu`）与蜂窝网络（`--rtt/--down`），测量 DSH 页面到可输入的耗时。
- 新增 `docs/native-android-evaluation.md`：冷启动实测、瓶颈拆分（局域网 CPU / 公网带宽）、三条路线（WebView 优化 / 原生快车道 / 全量 native）的成本与决策触发器。
- Android debug 包新增 `Dsh2PhonePerf` 日志（pageStarted / commitVisible / pageFinished / settled + transferKb / decodedKb / cached），仅 debug 生效。
- AGENTS.md 增加约定：**每次修改完成后必须提交并推送**。

## [1.5.1] - 2026-11-20

### 变更

- Android 1.2.1（versionCode 11）：**全端竖屏** —— `MainActivity` / `PairActivity` / `WebAppActivity` / `SettingsActivity` 与 zxing 扫码页统一 `screenOrientation="portrait"`，扫码改为 `setOrientationLocked(true)`；平板 / 分屏 / 自由窗口（宽度 ≥600dp）的方向由系统决定，Android 16 起系统会忽略这类限制，属系统行为。
- Android 1.2.1：**返回键先由页面处理** —— DSH 的 Web GUI 是单路由，前端不写 URL 历史（没有 `pushState`/`replaceState`，`canGoBack()` 恒为 false），所以按下返回键的顺序是：① 页面有浮层（`[role=dialog][aria-modal=true]` / `[role=alertdialog]` / `[role=menu]`）时按 DSH 自己的 Escape 契约关掉最上层；② 有真实网页历史则 `goBack()`；③ 否则回主页（WebView 实例保留，二次进入仍秒开）。同一浮层连按两次仍关不掉时交回 ②③，避免返回键被卡死；App 的错误横幅也先收掉。`MainActivity` 的主页返回改走 `OnBackPressedDispatcher`——targetSdk 35 的预测性返回默认开启，已废弃的 `onBackPressed()` 可能收不到返回键。
- 新增 `tools/mobile-back-check.mjs`：从 `WebAppActivity.java` 抽出返回键 JS，用极简 DOM 夹具验证 9 个分支（无浮层 / 关掉对话框 / 隐藏浮层不吞键 / 关不掉时第二次交回 / 冷却窗口 / 最上层优先）。
- 验证：`:app:assembleDebug`、`:app:assembleRelease`（含 lintVital）通过，合并清单里 5 个 Activity 全为 `portrait`；`:app:testDebugUnitTest` 通过；`node tools/mobile-back-check.mjs` 9/9 通过。真实 WebView 的 Escape 冒泡与竖屏行为需在真机/模拟器复验（步骤见 HANDOFF 的 Android 1.2.1 小节）。

## [1.5.0] - 2026-11-19

### 变更

- 新增启动健康检查（DSH 端口 / 隧道边缘 / 配置 / 会话密钥 / 中继五路自检），异常时在账号菜单与设置页提示
- 兼容策略改成“自检 + 降级壳”：peer 范围不再设上限（`>=0.2.1-rc.2`），DSH 升级后不会被 `incompatible-version` 整包拦下；`apply()` 先做 Host API 结构探测，激活失败时只注册一个仅含 `healthCheck` 的诊断壳并写 `[dsh2phone]` 日志，界面能看到原因而不是入口消失；Host 包树优先用运行中的 `app.asar`，再回落到 `.env` 的 `DSH_APP_DIR`；移除 DSH 0.2.2 已不存在的 `dsh-client-ui-slots` 客户端依赖

## [1.4.0] - 2026-11-03

### 变更

- 局域网直连：tunnel 新增局域网 HTTPS 直连边缘（自签证书 + 白名单门禁 + Host/Origin 重写，WS upgrade 穿透），relay 经控制面 `lan.announce` 转介、数据面 `/dsh-lan`（公网 URL `/dsh/dsh-lan`，设备门禁后）供已配对设备查询；Android 1.2.0（versionCode 10）检测同网电脑端时自动直连（证书指纹锁定，deny/panic 经白名单广播实时生效），失败自动回落公网。新配置 `DSH2PHONE_LAN_EDGE` / `DSH2PHONE_LAN_PORT`。
- 新工具 `tools/lan-direct-check.mjs`：本地 relay + 假 DSH + 真 tunnel 全链路验证直连边缘。
- `tools/mobile-e2e.mjs`：adb 调用全部改为异步（修复脚本阻塞事件循环导致假隧道被 relay 判 pong 超时的偶发失败）；新增 `MOBILE_E2E_LAN=1` 模式，用真 LAN 边缘验证 App 实际走直连。
- 验证：`lan-direct-check` 全链路通过；gradle 单测 39/39；`plugin-smoke` / `gate-repro` / `relay-dedupe-check` / `relay-pages-theme-check` / `plugin-config-check` 回归通过；模拟器 e2e 两种模式（公网 / 局域网直连）均 SMOKE PASS。

## [1.3.0] - 2026-10-29

### 新增

- Android 1.1.3：App 更名为 `MobiDSH`（中文 `移鲸`），启动图标改为大肥鱼 Q 版（YunYueSama，署名许可 1.0）。
- Android 1.1.7：修复模型选择菜单点击后瞬间关闭：菜单/按钮 click 不再触发收键盘，`hideKeyboard` 不再 `clearFocus`；focus guard 在触摸时立即停止。
- Android 1.1.6：状态栏改为 AndroidX EdgeToEdge 最佳实践（透明系统栏 + 根布局铺底 + 明确图标明暗），不再依赖 setStatusBarColor；增强页面背景取样（顶部元素/祖先），深色页面不再白底白字。
- Android 1.1.5：进入 App/从后台恢复时自动检查更新（15s 冷却，失败自动重试 2 次）；DSH 状态栏明确设置图标明暗，深色用 `#333`，避免状态栏和图标同时变白。
- Android 1.1.4：返回主页时保留 WebView Activity，再次进入只把已有实例提到前台，不重建、不重新请求 `/dsh/`；二次进入秒开。
- Android 1.1.x：WebView 移除原生 header，全屏沉浸式；状态栏/导航栏颜色读取 DSH 页面背景并自适应图标明暗。
- Android 1.1.x：自动升级。进入主页读取同源 `/dsh2phone/latest.json`，`versionCode` 更大时 App 内下载、校验 SHA-256/size，再交给系统安装器；设置页可手动检查更新。
- 服务端 `www/dsh2phone/latest.json` + APK 发布；下载页更新到 1.1.7。
- `www/dsh2phone/` 下载页重做为 MobiDSH / 移鲸 发布页（深色海洋视觉、版本/更新/能力/时间线/安装/SHA 复制），新增 `icon.webp`、`whale.webp` 页面素材。

### 修复

- 键盘：进入会话不再自动弹出软键盘（clearFocus + JS focus guard，用户触摸后解除）；IME 弹出时通过 WindowInsets 立即缩小 WebView，不等输入文字。
- WebView 返回键、SSL/外链/下载逻辑保持不变；下载仅对同 origin 带 cookie。
- 长按选择复制：WebView 显式 `setLongClickable(true)` / focusable，恢复文本选择 ActionMode（Copy / Share / Select all）。
- 初始页状态栏 padding：主页/配对/设置统一 `Bars.apply()`，按 systemBars/cutout/IME insets 调整根布局。
- DSH 页状态栏随页面变化：JS `MutationObserver` + 轮询把 `body` 背景通过 bridge 回传，页面加载/切主题后自动重刷；近黑色用 `#333` 规避 SystemUI 对比度保护。
- 发送后收键盘：页面任意短 click（输入框除外）或 Enter 调 bridge `hideKeyboard()`。

### 说明

- 1.0.0 包没有升级代码，需手动安装一次 1.1.7；1.1.0 起可自动升级到 1.1.7。
- 1.1.7 release APK SHA-256：`ad19abd08d65acbe7d7caa6b04c4cdd938d38d89c42fc661faee8b10d58e0103`。

## [1.2.0] - 2026-10-29

### 新增

- Android 客户端 `mobile/`（包名 `tech.xiaoniu.dsh2phone`，应用名「DSH 随身」）：App 内扫码、原生配对、Android Keystore 加密凭证、受控 WebView、设置页与诊断信息。
- `tools/mobile-e2e.mjs`：本地 relay + 假隧道 + adb 驱动 App 的端到端验证。
- `tools/deploy-relay.mjs`：relay 源码上传 + md5 校验 + 容器重建 + healthz。

### 修复

- relay：`pageRespond()`/`httpRespond()` 后立即 `socket.destroy()` 会截断 `Content-Length` 响应；数据面默认 `allowHalfOpen=false` 会在等待 PC 确认的客户端半关闭时提前关掉写端。已删除 destroy、改为 `net.createServer({ allowHalfOpen: true })`，并同步部署副本；生产 relay 已重建。
- Android：`PairingClient` 先解析 Set-Cookie 再读正文，正文截断时用 `/dsh/` 兜底；WebView 直接进入 `/dsh/`（不再绕 relay 入口页）；下载只对已配对 origin 携带 cookie。

### 验证

- `mobile/android`：31 个 JVM 单元测试通过；debug/release APK 构建通过；模拟器扫码、配对、WebView、设置页、进程重启恢复均验证。
- relay 回归：`gate-repro`、`relay-dedupe-check`、`relay-pages-theme-check`、`plugin-smoke` 通过；生产 `healthz=tunnel:online`，入口页/403 页完整。

## [1.1.1] - 2026-10-28

### 修复

- 版本检查器：工作区与基线一致时不再误报「只有 CHANGELOG.md 变化」，改为明确的「没有需要发版的改动」。

## [1.1.0] - 2026-10-28

### 新增

- 版本管理机制：`tools/version.mjs`（升级 + 生成日志条目）、`tools/version-check.mjs`（pre-push 强制校验）、`tools/install-git-hooks.mjs`（装钩子）。
- 插件「设置」页显示当前插件版本，便于排查"用户装的是哪一版"。
- `npm run version:check` / `npm run version:bump -- <type>` 脚本入口。

### 说明

- 1.0.0 期间「设置」标签（commit `71a8465`）在未升级版本号的情况下已发布——本机制就是为此加的。

## [1.0.0] - 2026-10-27

### 新增

- relay：设备白名单门禁、配对端点、控制面 WSS、TCP 多路复用（Docker 部署）。
- tunnel：本机出站隧道（run/pair/devices/allow/deny/remove/panic）、心跳看门狗、离线铸造 DSH cookie。
- 插件：账号菜单里的「配对手机」入口、配对二维码弹窗、设备管理（允许/停用/移除/全部吊销）。
- 插件「设置」标签：连接信息表单（写回 `.env`）、三段连通性测试、可复制的部署命令；配置缺失时自动跳转并高亮字段。
- 文档：README、交接文档、IP 应急方案、可行性评估（均已脱敏），截图脱敏脚本。
