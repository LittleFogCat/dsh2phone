# MobiDSH（移鲸，Android 客户端）

`dsh2phone` 的可选 Android 客户端：在 App 内扫码配对，配对与凭证管理走原生网络层，再用受控 WebView 打开 DSH。

它解决的是浏览器路线绕不开的几件事：

- 相机扫码后不再把一次性配对码交给外部浏览器；
- 配对请求由 App 原生发出，凭证存在 App 内并用 Android Keystore 加密，不受浏览器第三方 cookie / ITP / 无痕策略影响；
- WebView 只允许停留在已配对 origin，外链、SSL 错误、下载、文件选择都在 App 层处理；
- **全屏沉浸式**：DSH 页不再有 App 原生 header；状态栏/导航栏颜色读取页面 `body` 背景并自动切换图标明暗；
- **键盘**：进入会话不自动弹键盘；用户点输入框后 IME 弹出，WebView 立即整体上移（不等到输入文字）；发送后点击页面短按/Enter 自动收起键盘；
- **初始页**：主页/配对/设置页按状态栏、导航栏、刘海和 IME insets 加 padding，内容不会被状态栏压住；
- **菜单不闪退**：按钮/菜单触发器不触发“点页面收键盘”，`hideKeyboard` 不再 `clearFocus`；模型选择菜单可正常停留。
- **长按复制**：显式打开 WebView 的 long-clickable，长按文本会弹出 Copy / Share / Select all 选择条；
- **二次进入秒开**：返回主页时保留 WebView Activity（不 finish），再次进入只把已有实例提到前台，不重新请求 `/dsh/`；
- **状态栏**：AndroidX EdgeToEdge，系统栏透明，根布局铺到状态栏下方；页面背景取样（顶部元素/祖先）后设置根布局颜色，并明确切换图标明暗；
- **自动检查更新**：进入主页（含从后台恢复）读取同源 `/dsh2phone/latest.json`，15s 冷却；失败自动重试 2 次，不把一次失败当成已检查；
- **自动升级**：进入主页读取同源 `/dsh2phone/latest.json`，有新版本时 App 内下载、SHA-256 校验并交给系统安装器；
- **全端竖屏**（1.2.1 起）：主页 / 配对 / 设置 / WebView / 扫码页都锁竖屏（`screenOrientation="portrait"`），不随手机转动；
- **返回键**（1.2.1 起）：先关页面里的浮层（账户菜单、设置、模型选择、配对弹窗…，按 DSH 自己的 Escape 契约），没有浮层再走网页历史，最后回主页；同一浮层连按两次仍关不掉就直接回主页，不会把返回键卡住；
- **局域网直连**（1.2.0 起）：检测到电脑端在同一个局域网时自动直连 PC 上的隧道 HTTPS 边缘，不再绕公网 relay；证书按 relay 转介的指纹锁定，探测失败/断网自动回落公网；
- **现代简洁视觉**（1.3.0 起）：统一中性灰阶 + 品牌蓝的设计令牌，主页/设置/配对页重做，浅色与深色一致；
- **局域网直连开关**（1.2.2 起）：设置页可以关闭「局域网直连」；关闭后即使手机和电脑在同一局域网也强制走公网，便于验证公网链路或对比两条链路的性能；
- 可以显式信任某个主机的证书（仅用于“IP 直连但证书签给域名”的应急场景，默认关闭）。

包名：`tech.xiaoniu.dsh2phone`；应用名：`MobiDSH`（中文 `移鲸`）；版本：`1.3.0`（versionCode 13）。

## 和现有链路的关系

App **不修改** relay / nginx / 插件协议：

```
App 内扫码
  └─ 原生 HTTPS GET  https://<PUBLIC_DOMAIN>/dsh-pair?code=…
       └─ relay 照常走 pair.request → 电脑端“允许” → 下发 dshdev + dsh-auth-*
  └─ 凭证加密落盘
  └─ WebView 直接开 /dsh/（CookieManager 注入后的顶层导航同时带 Lax/Strict）
```

配对二维码仍由电脑端插件生成；App 只是换了一个“扫码 + 保存 cookie + 打开页面”的壳，安全模型不变。

### 局域网直连（1.2.0 起）

进入 DSH 前，App 会做一次直连决策（`LanDirect`）：

1. 查询 relay 的 `GET /dsh/dsh-lan`（带设备 cookie 过门禁）→ 电脑端 tunnel 通过控制面
   `lan.announce` 通告的 `{port, 证书指纹, 私网 IP 列表}`，或上次会话缓存的直连地址；
2. 对候选地址逐个做**指纹锁定**的 TLS 探活（`/dsh2phone-lan-hello`）；
3. 命中 → 以 `https://<电脑IP>:<port>/` 进入 DSH（直连边缘的根就是 DSH 根）；
   未命中 / relay 无通告 / 超时 → 照旧走公网 origin。

信任与回落规则：

- 直连目标身份由“relay 下发的证书指纹（SHA-256 of DER）”保证，不走系统证书链，
  也不复用「允许证书不匹配」开关；指纹不匹配（LAN 内冒充 / 电脑端换了证书）立即取消并回落公网。
- 会话中途断网（离开家 / Wi-Fi 切换）→ `onReceivedError` 静默回落公网并提示横幅。
- 电脑端 deny/allow/remove/panic 通过 relay 的白名单广播实时同步到局域网边缘，
  直连与公网同时生效；直连流量不经过 relay，设备列表的“最后在线”只反映公网访问。
- 下载：DownloadManager 无法锁定自签证书，直连同源下载会自动改写到公网等价地址再交给系统下载。
- 电脑端开关：`.env` 的 `DSH2PHONE_LAN_EDGE=0` 关闭直连边缘；`DSH2PHONE_LAN_PORT` 改端口。

> ⚠️ 原生配对会读取 `/dsh-pair` 的成功页（设备名/入口 href），WebView 则直接进 `/dsh/`。
> relay **必须**是包含“响应写完再关闭 socket + 允许半关闭”修复的版本
> （`pageRespond` 后不再立即 `socket.destroy()`，数据面 `net.createServer({allowHalfOpen:true})`）；
> 旧版 relay 在 PC 确认后才写响应时会偶发 `unexpected end of stream` /
> `net::ERR_CONTENT_LENGTH_MISMATCH`。部署命令见文末。

## 构建

前置：

- JDK 17（AGP 8.7.3 要求）
- Android SDK Platform 35 + Build-Tools 35
- 可访问 Google Maven / Maven Central（或配置镜像）

```powershell
cd mobile/android

# 方式 A：Android Studio 打开 mobile/android
# 方式 B：命令行（首次会下载依赖）
$env:JAVA_HOME = 'C:\path\to\jdk-17'
$env:ANDROID_HOME = 'C:\path\to\Android\Sdk'
Copy-Item local.properties.example local.properties   # 按需修改 sdk.dir
.\gradlew.bat :app:assembleDebug
```

APK 输出：`app/build/outputs/apk/debug/app-debug.apk`。

如果构建机是受限环境（Gradle native-platform / 文件监听被拦截），可加：

```powershell
$env:GRADLE_OPTS='-Dorg.gradle.native=false'
.\gradlew.bat :app:assembleDebug --no-daemon --no-watch-fs
```

### 签名 release 包

`app/build.gradle` 会读取 `mobile/android/keystore.properties`；没有该文件时退回 debug 签名（仅供本地验证，不能用于分发）。本机生成：

```powershell
keytool -genkeypair -v -keystore mobile/android/keystore/dsh2phone-release.jks `
  -alias dsh2phone -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass <PASSWORD> -keypass <PASSWORD> `
  -dname "CN=dsh2phone, OU=Mobile, O=dsh2phone, C=CN"

@"
storeFile=keystore/dsh2phone-release.jks
storePassword=<PASSWORD>
keyAlias=dsh2phone
keyPassword=<PASSWORD>
"@ | Set-Content mobile/android/keystore.properties -Encoding utf8
```

`keystore.properties` 与 `keystore/` 已在 `.gitignore` 中，**不要入库**。换签名 key 后已安装用户必须卸载重装。

```powershell
cd mobile/android
.\gradlew.bat :app:assembleRelease
```

## 图标与第三方素材

启动图标使用「大肥鱼／鲸鱼娘」Q 版形象：作者 **YunYueSama**，
来源 [codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet)，
按“大肥鱼项目署名许可 1.0”使用；本 App 对原图做了裁剪、缩放和背景合成。
完整说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。该形象为社区同人创作，不代表 DeepSeek 官方授权。

## 自动升级

App 每次进入主页（已配对时）读取：

```
<配对 origin>/dsh2phone/latest.json
```

manifest 格式：

```json
{
  "versionCode": 13,
  "versionName": "1.3.0",
  "apkUrl": "dsh2phone-1.3.0-release.apk",
  "sha256": "<APK SHA-256>",
  "size": 2387029,
  "notes": "本次更新说明"
}
```

- `versionCode` 大于当前包才提示；`apkUrl` 支持相对路径，但必须与 manifest 同 origin；
- 下载沿用配对时的证书策略（IP 直连 + 证书不匹配时也能更新），下载后校验 `size` + `sha256`；
- 通过 `FileProvider` 交给系统安装器；首次需要允许「安装未知应用」，授权后返回 App 会重新检查并安装；
- 设置页也有「检查更新」可手动触发；
- **1.0.0 没有升级代码**，需要先手动安装 1.1.7；1.1.0 起可自动升级到 1.1.7。

发布新版本时，把新 APK 与 manifest 放到服务端同一个 `/dsh2phone/` 目录，并提升 `versionCode`；`latest.json` 的 `sha256/size` 必须对应新 APK。

## 使用

1. 电脑 DSH → 左下角账号菜单 → **配对手机** → 显示二维码。
2. 手机打开 App → **扫描二维码配对**（或“粘贴配对链接”）。
3. 确认主机（防止配对码被带到别的服务器）→ 等待电脑端弹窗点“允许”。
4. 成功页点 **进入 DSH**；之后从主页一键进入。
5. 重装 App / 换手机 → 重新扫码；电脑端设备列表里可移除旧记录。

设置页可以：

- 查看当前主机 / 设备名 / 配对时间；
- 重新配对、解除本机配对（只清本机，不删电脑端记录）；
- 开关“局域网直连”（默认开；关闭后同网也走公网，便于测试）；
- 开关“允许此主机的证书不匹配”（默认关，开启前有明确警告）；
- 复制诊断信息（版本 / UA / origin / 设备名，不含 cookie）。

## 安全边界

- **配对码只发给二维码里的 origin**；`PairUrl` 只接受 `https`（debug 包里额外允许 `10.0.2.2` / `127.0.0.1` / `localhost` 的 http），且必须带 `code`，不跟随 302。
- **凭证加密**：`dshdev` 与 `dsh-auth-*` 用 Android Keystore AES-GCM 加密后写入私有 SharedPreferences；`allowBackup=false`，系统备份拿不走。
- **WebView 锁 origin**：同 origin 才在 WebView 内导航；外链弹确认后用系统浏览器打开；`file://` 禁止；混合内容禁止；无 JS Bridge。配对正文即使被中间层截断，只要 header 里拿到 `dshdev` 就仍按成功处理，入口用 `/dsh/` 兜底。
- **证书**：默认严格校验。只有用户在设置页（或证书错误弹窗）显式确认后，才对**该 origin**放开校验，并写入设置；随时可关。
- **无统计/广告**，权限只有 `INTERNET` + `CAMERA`。
- 设备身份 UA 形如 `dsh2phone/1.1.7 (Android 14; Pixel 9; 1a2b3c4d)`，最后的哈希来自 Android ID，用于 relay 在没有 cookie 时按 UA 去重；不包含明文设备 ID。
- 自动升级下载的 APK 必须与 manifest 的 `sha256`、`size` 完全一致才会交给安装器；APK URL 必须与 manifest 同 origin。

## 已知边界

- **WebView 仍是 Chromium**：如果网络侧按 SNI/TLS 指纹重置，WebView 也可能受影响；IP 直连 + 显式信任证书是应急方案，不保证所有网络。
- **下载**：只处理 `http(s)` 直链（带 App 内 cookie 交给 DownloadManager）；`blob:` / `data:` 会提示用浏览器打开。
- **窗口**：`window.open` 同站链接在当前 WebView 打开，其他链接走外部浏览器确认；DSH 若依赖复杂多窗口流程，后续再补。
- **不要把它当后台常驻客户端**：App 不维持后台连接，DSH 的实时性仍由打开时的 WebSocket 决定。
- **竖屏是系统级限制**：四个 Activity 与扫码页都声明了 `portrait`；但 Android 16 起系统会忽略宽度 ≥600dp 应用的方向限制，平板 / 分屏 / 自由窗口下仍可能横过来——这是系统行为，App 无法强制。
- **返回键只关浮层，不做“网页后退”**：DSH 的 Web GUI 是单路由，前端不写 URL 历史（没有 `pushState` / `replaceState`），所以 WebView 的 `canGoBack()` 恒为 `false`；返回键因此用于关闭 `[role=dialog][aria-modal=true]` / `[role=menu]` 这类浮层。右侧栏（文件 / 终端 / 浏览器）不是对话框，需要点面板自己的关闭按钮。
- **iOS 未构建**：本机是 Windows；配对/凭证/WebView 逻辑已按可移植方式分层（`PairUrl` / `SetCookie` / `PairingClient` 纯 Java），后续可在 macOS 上做原生或跨平台版本。

## 验证

纯 JVM 单元测试（不依赖模拟器）：

```powershell
cd mobile/android
.\gradlew.bat :app:testDebugUnitTest
```

覆盖：配对 URL 校验、Set-Cookie 解析（含 `Expires` 逗号 / 多 cookie / Domain 校验）、HTML 提取、UA、PairingClient 的成功/过期/拒绝/503/500/取消/正文截断、局域网直连候选解析与指纹归一化，共 38 个用例。

返回键的页面侧逻辑（提取 `WebAppActivity.BACK_DISMISS_JS` 用极简 DOM 夹具跑，不需要设备）：

```powershell
node tools/mobile-back-check.mjs
```

覆盖：没有浮层时交回原生、有浮层时按 DSH 的 Escape 契约关掉、隐藏浮层不吞返回键、同一浮层关不掉时第二次交回原生、最上层优先。真实 WebView 的 Escape 冒泡（DSH 在 `document` 捕获阶段监听）需要在真机上再复验一次。

模拟器/真机端到端（需要已启动的 adb 设备）：

```powershell
node tools/mobile-e2e.mjs
```

脚本会起本地 relay + 假隧道 + 模拟 DSH，自动批准 PC 确认，并用 adb 驱动 App：深链 → 确认 → 原生配对 → WebView 进入 `/dsh/` → 回主页。截图在 `mobile/dist/`（已忽略）。这是本地验证，不碰生产白名单。

## 目录

```
mobile/android/
├─ app/src/main/java/tech/xiaoniu/dsh2phone/
│  ├─ MainActivity.java          主页 / 扫码入口 / 深链 / 状态探测
│  ├─ PairActivity.java          原生配对等待页
│  ├─ WebAppActivity.java        全屏受控 WebView / 状态栏配色 / 键盘处理 / 返回键（先关浮层）
│  ├─ UpdateManager.java         latest.json 检查 + 原生下载 + 安装
│  ├─ SettingsActivity.java      配对 / 证书 / 诊断
│  ├─ PairUrl.java               二维码链接校验（纯 Java）
│  ├─ SetCookie.java / Cookie.java   Set-Cookie 解析（纯 Java）
│  ├─ PairingClient.java         原生配对请求（纯 Java）
│  ├─ PairStore.java / SecurePrefs.java   加密持久化（含局域网直连入口缓存）
│  ├─ LanDirect.java              局域网直连：候选解析 / 指纹锁定探活（纯 Java）
│  ├─ Pairing.java / PairProbe.java / PairingErrors.java
│  └─ AppIdentity.java           稳定 UA
├─ app/src/test/…                JUnit 4
└─ app/src/main/res/…            中文默认 / 英文 values-en / 深浅色
tools/mobile-e2e.mjs             本地 e2e
tools/mobile-back-check.mjs      返回键浮层逻辑检查（提取 Java 里的 JS + DOM 夹具）
tools/deploy-relay.mjs           relay 同步 + 重建 + healthz
```

## relay 部署（让 App / 浏览器稳定打开入口页）

本仓库的 `relay/src/relay.mjs` 修掉了 `pageRespond` 后立即 `socket.destroy()` 的截断，并把数据面
改成 `net.createServer({ allowHalfOpen: true })`，避免等待 PC 确认期间客户端半关闭写端。
生产 relay 需要重建一次：

```powershell
node tools/deploy-relay.mjs            # 上传 + md5 校验 + docker compose up -d --build
node tools/deploy-relay.mjs --check    # 只比较远端 md5
```

脚本从 `.env` 读取 SSH 信息，不会打印密钥；重建后等待 PC 隧道自动重连（≤70s），
`healthz` 变为 `tunnel:online` 即完成。也可按 README 手工在服务器执行。

## 构建产物

`mobile/dist/`（已忽略）中保留：

- `dsh2phone-1.1.7-debug.apk` — 调试包（允许本地 http e2e）
- `dsh2phone-1.1.7-release.apk` — 本机签名 release 包
- `latest.json` — 自动升级 manifest（与服务端同源）
- `e2e-*.png` — 模拟器验证截图（仅本地，不入库）
