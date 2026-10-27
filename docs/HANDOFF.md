# dsh2phone 交接文档（新会话从这里开始）

> 更新：2026-10-27
> 用途：交给新的"创造模式"会话继续开发。本文档自包含，不依赖原会话上下文。
>
> ⚠️ 本文档已脱敏：域名 → `<PUBLIC_DOMAIN>`、服务器 IP → `<SERVER_IP>`、SSH 账号/私钥 → `<SSH_USER>` / `<SSH_KEY>`、本机路径 → `<REPO_DIR>` / `<DSH_APP_DIR>`。真实值只在本机 `.env`（已被 `.gitignore` 忽略）。配置项一律以 `.env` 为准，代码里不再硬编码。

---

## 一、项目是什么

**dsh2phone**：让手机通过公网（https://<PUBLIC_DOMAIN>/dsh/）访问本机 DSH Desktop 的 Web GUI。
已完成并上线：自研 WSS 中继 + 本机隧道 + 设备白名单四道防线。

### 最终架构

```
手机浏览器 ──HTTPS──► nginx(<PUBLIC_DOMAIN>:443)
                        │  location /dsh/      → dsh-relay:3200（剥离前缀，Host 固定传 127.0.0.1:43120，剥离 Origin）
                        │  location /dsh-pair  → dsh-relay:3200/pair（配对端点）
                        │  location /dsh-tunnel→ dsh-relay:3201/tunnel（控制面 WSS）
                        ▼
                   dsh-relay 容器（设备注册表 + 门禁 + 配对 + 多路复用）
                        ⇕ WSS（PC 主动出站，VBS 守护）
                   tunnel（本机 Node）──loopback──► DSH Desktop webserver 127.0.0.1:43120
```

**关键事实（已验证）**：

- DSH 信任栅栏：请求 Host 为 loopback 即通过 → nginx 固定传 `Host: 127.0.0.1:43120` + 剥 Origin → **DSH 端零配置改动**
- DSH Web GUI 完全支持路径前缀挂载（客户端用 `document.baseURI` 相对解析 API/WS 路径）；`/dsh/` 下 RPC、WebSocket、cookie 换取全部正常
- DSH 浏览器 cookie 可以在 PC 侧离线铸造（见下"cookie 铸造"），因此 **token 完全不需要出现在公网**

---

## 二、仓库布局（<REPO_DIR>）

| 路径 | 说明 |
|---|---|
| `relay/src/relay.mjs` | 中继服务（已部署到服务器，docker 容器 dsh-relay） |
| `relay/Dockerfile` | node:22-alpine，依赖仅 ws |
| `tunnel/src/tunnel.mjs` | 本机隧道。模式：run（主进程）/ pair / devices / allow / deny / remove / panic |
| `tunnel/src/dsh-cookie.mjs` | **DSH 浏览器 cookie 铸造模块**（插件开发要复用） |
| `tunnel/start.cmd` | 隧道主进程（只设置 `DSH2PHONE_ENV_FILE`，密钥/端点从 `.env` 读） |
| `tunnel/pair.cmd` | CLI 配对入口（二维码 + 终端确认） |
| `tunnel/devices.cmd` | 设备管理 |
| `tunnel/autostart.vbs.example` | 开机自启模板（装入用户 Startup 文件夹后隐藏窗口 + 崩溃自动重启，日志写 `tunnel.log`；真实 `.vbs` 含本机路径，已忽略） |
| `shared/env.mjs` | **唯一的配置入口**：加载 `<repo>/.env`，提供 `env()/envFlag()/requireEnv()` |
| `.env.example` | 配置模板（入库）；`.env` 是真实值（忽略） |
| `tools/check-env.mjs` | 打印实际生效的配置（密钥打码），启动前自检 |
| `tools/render-plugin-patch.mjs` | 生成插件 `cordis.patch.yml`（含本机绝对路径，故不入库） |
| `tools/redact_screenshots.py` | 给 `docs/` 截图脱敏（模糊侧栏/账号区、遮盖二维码）；**更新截图后必须重跑** |
| `deploy/nginx/dsh.location` | nginx 配置（已部署） |
| `deploy/server/docker-compose.yml` | 服务器 compose（已部署，含 dsh-relay 服务 + state 卷） |
| `deploy/server/tunnel.key` | 隧道共享密钥的旧位置（明文，**已忽略**；密钥现由 `.env` 的 `DSH_TUNNEL_KEY` 提供，文件仅为兼容旧的 Startup VBS 保留） |
| `deploy/prefix-test.mjs` | 本地仿真代理（TLS :9443，前缀剥离 → 上游可用 env UPSTREAM 覆盖） |
| `tools/gen-cert.mjs` | node-forge 自签证书（deploy/tls/） |
| `tools/gui-e2e.mjs` | Playwright + 本机 Edge 无头 GUI 验证 |
| `dsh2phone-dsh-plugin/` | **DSH 插件**（已安装到 desktop profile）：配对二维码 UI + 设备管理，详见第六节 |
| `tools/plugin-smoke.mjs` | 插件 host 协议冒烟（本地 relay + 模拟隧道） |
| `tools/plugin-e2e-pair.mjs` | 插件端到端配对验证（真 GUI + 生产 relay + 模拟手机） |
| `tools/plugin-gui-check.mjs` | 插件 GUI 冒烟（账号菜单内的入口 / 二维码 / 设备页） |
| `tools/plugin-gui-entry-check.mjs` | 入口位置（账号菜单内、侧栏底部无按钮）、键盘可焦点、弹窗 a11y（Esc/点外关闭） |
| `tools/gui-entry.mjs` | 上述脚本共用的入口操作（打开账号菜单 → 点"配对手机"） |
| `docs/proposal.md` | 原始方案文档（v2） |

## 三、服务器信息（<PUBLIC_DOMAIN>）

- SSH：`ssh -i <SSH_KEY> <SSH_USER>@<SERVER_IP>`（真实值见本机 `.env` 的 `DSH2PHONE_SSH_*`）
- 部署根：`/usr/local/compose`（docker-compose：nginx + mongodb + backend + dsh-relay）
- relay 源码：`/usr/local/compose/data/dsh-relay/`（state 卷：`data/dsh-relay/state/devices.json`）
- 密钥在 `/usr/local/compose/.env` 的 `DSH_TUNNEL_KEY`（必须与本机 `.env` 的 `DSH_TUNNEL_KEY` 相同）
- nginx conf：`/usr/local/compose/conf/nginx/conf.d/dsh.location`；重载：`docker exec nginx nginx -s reload`
- ⚠️ **scp 曾静默失败**（文件没传上去但无报错）——上传后必须 `md5sum` 校验，或改用 `cat file | ssh "cat > 目标"` 管道方式
- ⚠️ 顺手待办：mongodb 27017 与 backend 3001 仍暴露公网（用户已知情，未做）

## 四、已实现的安全模型（四道防线，全部已验证）

1. **设备白名单**：relay 对每个连接窥视 HTTP 头，要求签名设备 cookie `dshdev=<uuid>.<hmac>` 且注册表 status=allow，否则 403
2. **token 公网作废**：带 `?token=` 的请求一律 403（token 只存在于局域网链路）
3. **配对制**：`pair` 发起一次性配对码（5 分钟）→ 手机访问 /dsh-pair → relay 经控制面请求 PC 确认 → 通过后注册设备 + 下发设备 cookie + **铸造的 DSH cookie** → **200 返回“入口页”**（含“进入 DSH”按钮与“添加到主屏幕”提示，不再 302 自动跳转；落地页会 `history.replaceState` 去掉一次性 code，便于收藏/加桌面）。`/dsh-pair` 同时是已配对设备的入口页：带有效 `dshdev` 时直接显示入口页；无 code 且未配对时显示“需要先配对”说明页；隧道离线时返回 503“电脑端连接中”而不是断连
4. **管理/吊销**：devices 列表（名称/UA/最后在线/IP）、deny 即时拉黑、panic 全部吊销

### cookie 铸造格式（精确，勿改）

- 密钥：`~/.dsh/.credentials.yaml` 中 `client-connection/browser-session` 记录的 `payload.secret`（32 字节 base64url）
- authority：`"127.0.0.1:43120"`（= DSH 收到的 Host 头，HTTP 场景不带 scheme）
- name：`"dsh-auth-" + base64url(sha256(authority))`
- value：`v1.` + `base64url(JSON {version:1, authority, issuedAt, expiresAt})` + `.` + `base64url(HMAC-SHA256(secret, body))`
- 属性：`Max-Age=<秒>; Path=/; Expires=<UTC>; HttpOnly; SameSite=Strict`（无 Secure）
- 参考实现：`tunnel/src/dsh-cookie.mjs`；权威源码：DSH 安装目录 `node_modules/@deepseek-ai/dsh-client-connection/lib/index.js` 270–400 行

### relay 控制面协议（JSON text 帧；数据面二进制帧 = [4B streamId BE][payload]）

```
→ {t:"hello", key, mode?: "admin"}          ← mode=admin 是管理连接（不动数据面）
← {t:"hello.ok", mode}
→ {t:"pair.start"}                           ← 管理连接发起
← {t:"pair.session", code, expiresAt}        ← 码由 relay 生成
← {t:"pair.request", reqId, code, ua, ip, existing?}  ← 需 PC 确认；existing={id,name} 表示该浏览器已配对，确认后复用条目（不新增）
→ {t:"pair.response", reqId, approved, device:{id,name}, dshCookie}   ← dshCookie 是完整 Set-Cookie 字符串
← {t:"ok"} / 手机收到 303 + 两枚 cookie → 302 /dsh/
→ {t:"devices.list"} ← {t:"devices", devices:[...]}
→ {t:"devices.set", id, status:"allow"|"deny"} / {t:"devices.remove", id} / {t:"devices.panic"}
← {t:"device.registered", device}            ← 广播给所有控制连接
```

## 五、DSH Desktop 环境事实

- 版本 2.0.18 / @deepseek-ai/dsh 0.2.1-rc.2；安装目录 `<DSH_APP_DIR>\`
- `node_modules\@deepseek-ai\*` 每个包都有**中文 README**（README.zh.md）——开发前必读相关包
- GUI：loopback :43120；LAN HTTPS edge :2622（networkExposure=lan 已开）；`~\.dsh\` 为 DSH_HOME；desktop profile：`~\.dsh\profiles\desktop`
- 已启用的参考插件：`@agents-anywhere/dsh-bridge-next`（profile bundles 里有）——**第三方插件开发的最佳真实样例**
- 当前 GUI 主体渲染正常，DSH 零改动即可被隧道访问

---

## 六、✅ 已完成：DSH 插件（手机配对 UI）

### 结果

左下角侧栏底部的**账号菜单**（点最底部账号行弹出，与"设置 / 意见反馈 / 退出登录"并列）里出现 **"配对手机"** 一行 → 弹窗显示二维码（host 端用 `qrcode` 生成 PNG dataURL）→ 手机扫码后 **DSH 内弹确认框**（设备名/IP）→ 允许后 relay 下发 cookie 并返回**手机入口页**（“进入 DSH”按钮 + 添加到主屏幕提示；`/dsh-pair` 本身也是已配对设备的入口页）→ 点按钮进入 `/dsh/`。弹窗内"设备管理"页可 allow/deny/remove/全部吊销。侧栏底部不再单独放按钮；CLI（pair.cmd 等）保持可用。

### 插件位置与安装

```
dsh2phone-dsh-plugin/
├─ package.json          # name: dsh2phone; dsh.bundle.patch + dsh.client(web, immediately)
├─ cordis.patch.yml      # 生成的：插入 host 行（行名是 host.js 的 file:/// 绝对 URL，见下"坑 1"）— 已忽略
├─ cordis.patch.example.yml # 模板；`node tools/render-plugin-patch.mjs` 生成上面那个
├─ host.js               # Host 面：Typert Remote 服务（dsh2phone 命名空间）；配置全部来自 .env
├─ relay-admin.js        # relay 控制面 admin 客户端（hello / pair.* / devices.*）
├─ dsh-cookie.js         # 移植自 tunnel/src/dsh-cookie.mjs（secret/authority 参数化）
├─ client.js             # __ModuleLoader__ 客户端：shell.overlay 弹窗 + 账号菜单行（DOM 嫁接见坑 8）
├─ locale/{zh,en}.json   # 插件展示元数据（meta.title/description）
└─ icon.svg              # 插件图标
```

安装（**不要**手改 profile 的 package.json / cordis.patch.yml）：

```
node tools/render-plugin-patch.mjs        # 换目录/换机器后先重新生成 patch
plugin_manager install_bundle target=<REPO_DIR>\dsh2phone-dsh-plugin
```

profile 里记录为 `"dsh2phone": "link:<REPO_DIR>/dsh2phone-dsh-plugin"`，行 id `include:dsh2phone`。

### 配置（全部来自 `.env`，`cordis.patch.yml` 的 config 保持空）

| `.env` 变量 | 作用 |
|---|---|
| `RELAY_URL` | `wss://…/dsh-tunnel`（控制面） |
| `PUBLIC_PAIR_URL` | `https://…/dsh-pair`（二维码内容 = 此地址 + `?code=…`） |
| `DSH_TUNNEL_KEY` | relay 共享密钥（优先；也可用 `DSH2PHONE_KEY_FILE` 指向文件） |
| `DSH_AUTHORITY` | `127.0.0.1:43120`（= DSH 看到的 Host 头，不要跟公网域名改） |
| `DSH2PHONE_TTL_DAYS` | `30`（铸造 cookie 的有效期） |
| `DSH_CREDENTIALS_FILE` | 留空 = `~/.dsh/.credentials.yaml` |
| `DSH_APP_DIR` | DSH Desktop 安装目录（解析 `@deepseek-ai/*` 原生副本） |
| `DSH2PHONE_ALLOW_INVALID_CERT` | `1` = 跳过 relay 证书校验（仅 IP 应急） |

改完 `.env` 后：`node tools/check-env.mjs` 自检，再重启 Desktop（host.js 是进程内模块，不会热读）。

### Remote 方法（namespace `dsh2phone`）

`pairStart` / `pairInspect(id)` / `pairRespond(id, reqId, approved)` / `pairCancel(id)` / `devicesList` / `devicesSet(id,status)` / `devicesRemove(id)` / `devicesPanic`。
配对确认采用**轮询**（client 每 1.5s `pairInspect`）而非 host→client 推送事件，避免依赖 Typert 事件转发。

### 踩过的坑（重要，改插件前必读）

1. **工作区 link 插件无法从 Host 包树解析**：client-modules 扫描用 `entry.parent.tree.ctx.baseUrl` 定位包，工作区 link 的包在 Host 树里不存在 → client 模块不会进入启动图（`__DSH_BOOT__` 里没有该行，页面无任何报错）。解决：`cordis.patch.yml` 的行名写成 **`file:///D:/…/host.js`**，Loader 的 `nearestPackage` 会从文件向上找到本包 `package.json`。
2. **client 包元数据按 `(baseUrl, loaderName)` 缓存到进程重启**，解析失败会缓存 `null`。所以改行名后要重新 install（新 sourceKey），或重启 Desktop。另：client bundle 的 revision 由文件 mtime/size 计算，改 `client.js` 后新开页面即生效，无需重启。
3. **Remote 服务方法里不能用 `#private` 方法/字段**：cordis 用 Proxy 作为 `this` 调用服务方法，V8 私有品牌检查失败，报 `Receiver must be an instance of class <X>`（错误发生在方法**内部**第一行私有调用处）。用普通方法（如 `closePair()`）即可。
4. **`@deepseek-ai/*` 必须用 Host 自己的副本**：否则插件是第二份 cordis/typert 类，网关校验 Receiver 时身份不一致。host.js 先按 `DSH_APP_DIR` / `<execPath>/resources/app` 用 `createRequire` 解析，失败才回退普通 import。
5. **QR 不要在 client 里造轮子**：host 端 `qrcode.toDataURL(url,{errorCorrectionLevel:'M',margin:3,width:320})`，client 只渲染 `<img src=…>`。
6. **client UI 不 require `dsh-client-ui-primitives`**（按插件开发规范）：自绘控件，只用 `--dsw-alias-*` 主题 token；弹窗用 `shell.overlay` 槽位而非 portal 到 body。
7. 改 `host.js` 代码需要重启 Desktop（ESM 模块按 URL 缓存）；临时免重启验证技巧：把行名指向一个新文件名（如 `host-v2.js`）再 reinstall，新 URL = 新模块。
8. **账号菜单没有菜单项槽位**："设置 / 意见反馈 / 退出登录"这个弹窗由 `@deepseek-ai/dsh-client-ui-settings-account` 的 `AccountMenu` 内部渲染（`settings.launcher` 是 single 槽位，注册谁就整体顶掉谁），没有可追加菜单项的 Slot。所以"配对手机"这一行是 **DOM 嫁接**：`installAccountMenuEntry` 观察 `document.body` 的 childList，等 portal 到 body 的 `[role="menu"]` 出现后，克隆一行原生菜单行（继承它自己的 class，尺寸/hover/focus 与原生一致），把图标换成电话、文案换成"配对手机"，插在登录/退出登录那行之前；点击时先 `dispatchEvent(Escape)` 让弹窗自己关掉，再开我们的 dialog（弹窗 portal 的 z-index 1100 会盖住 dialog 的 1000）。识别条件很窄：该菜单必须同时有"设置/Settings"行和"登录/退出登录/Sign in/Sign out"（或"意见反馈/Feedback"）行，且行文案用 `includes` 匹配（设置行文本带快捷键 "设置Ctrl+Alt+,"）。**升级 DSH 后若入口消失**，先用 `tools/plugin-gui-entry-check.mjs` 看 `menuRows`，再核对上面这两条 DOM 契约。

### 验证脚本（tools/）

| 脚本 | 用途 |
|---|---|
| `plugin-smoke.mjs` | 起本地 relay（13200/13201）+ 模拟隧道，跑通 pair.start→pair.request→pair.response→303→设备注册→deny/remove |
| `plugin-e2e-pair.mjs` | 真 GUI + 生产 relay 端到端：开弹窗→取配对码→模拟手机访问 `https://<PUBLIC_DOMAIN>/dsh-pair`→GUI 确认→303+cookie→设备入列→两步移除清理 |
| `plugin-e2e-gate.mjs` | 真浏览器验公网门禁：配对后 `/dsh/` 200 → 插件停用 → 403"已被停用" → 启用 → 200 → 移除 → 403"未知设备" |
| `plugin-gui-check.mjs` | GUI 冒烟：账号菜单里有入口行、弹窗、二维码 PNG、设备页、关闭 |
| `plugin-gui-entry-check.mjs` | 入口位置（账号菜单内、侧栏底部无按钮）、键盘可达、dialog a11y、Esc 与点外关闭、重开菜单仍注入 |
| `gui-entry.mjs` | 上面两个脚本共用的入口操作（`accountTrigger` / `pairMenuItem` / `openPairDialog`） |
| `gate-repro.mjs` | 门禁逻辑离线复现（生产密钥 + 注册表副本 + 假隧道） |

### 附带修复：relay 门禁的重大 bug（本次已修并部署）

`relay/src/relay.mjs` 的 `parseDeviceCookie` 收到的是**整行 `cookie: dshdev=…`**（数据面窥视时取的是整行），而它把第一段名字与 `dshdev` 严格比较，永远返回 `undefined` → **任何已配对设备访问 `/dsh/` 都会被判"未知设备"**。此前只验证过 403 拒绝路径，成功路径从未跑通。修复方式：函数开头剥掉可选的 `cookie:` 前缀。已用 `plugin-e2e-gate.mjs` 在生产验证（配对→200、停用→403、启用→200、移除→403）。

⚠️ 部署时注意：上传后必须 `md5sum` 比对（PowerShell 管道会改编码，需用 base64 传输或 scp+校验），然后 `docker compose up -d --build dsh-relay`，并确认 `docker logs dsh-relay` 有 `loaded N device(s)` 与 `tunnel online`、healthz 为 `tunnel:online`。


### 验收清单（全部通过）

- [x] 插件安装后"配对手机"出现在左下角**账号菜单**内（与"设置 / 意见反馈 / 退出登录"并列，`tools/plugin-gui-entry-check.mjs`：`menuRows` = 设置/意见反馈/配对手机/退出登录、侧栏底部按钮数为 0、方向键可达、点击后弹窗打开且菜单关闭）
- [x] 弹窗显示二维码，手机扫码后 DSH 内弹出确认框（`plugin-e2e-pair.mjs`：`confirmShown: true`）
- [x] 确认后手机看到入口页（“进入 DSH”+ 添加到主屏幕提示），点按钮进入 `/dsh/` 返回 200 且应用渲染；已配对设备重开 `/dsh-pair` 仍是入口页
- [x] 弹窗内可 deny/allow/remove/panic 设备，公网行为即时变化（`plugin-e2e-gate.mjs`：200→403→200→403）
- [x] CLI pair.cmd 仍可用（`node tunnel/src/tunnel.mjs devices` 正常返回）


---

## 七、当前运行状态快照

- 隧道：开机自启（Startup VBS），日志 `tunnel.log`；服务器 healthz `tunnel:online`（当前走域名 `wss://<PUBLIC_DOMAIN>/dsh-tunnel`）
- 公网：`https://<PUBLIC_DOMAIN>/dsh/` → 未配对设备 403"未知设备"；`?token=` → 403
- 插件：`dsh2phone` 已安装并启用（desktop profile，`include:dsh2phone`），行名 `file:///<REPO_DIR>/dsh2phone-dsh-plugin/host.js`；GUI 左下角账号菜单内"配对手机"可用（截图 `docs/plugin-gui-menu.png`）
- relay：已部署**门禁修复版**（`parseDeviceCookie` 剥 `cookie:` 前缀）+ 入口页/503 降级版；容器 `dsh-relay` 已重建
- 已配对设备：生产注册表 2 台（`Android · Android 16 Chrome` 10-25、`Android · Android 10 Chrome` 10-27）；测试设备均已清理，同 UA 重复条目已去重（见下）
- 本地 e2e 栈（复测用）：relay(:3200/:3201, key=e2e-test-key) + tunnel(run) + prefix-test(:9443→3200)，cookie jar `.e2e-jar.txt`
- ⚠️ 新会话注意：若改动 relay 代码，上传服务器后必须 `docker compose up -d --build dsh-relay` 并核对 `docker logs dsh-relay` 里的版本特征（v2 特征串："device gate:"）
- ✅ 已解决的历史遗留：工作区 link 插件的 client 模块原本不进启动图（见第六节"坑 1/2"）；host 代码改动仍需重启 Desktop（或在 patch 里换新文件名）

### 2026-10-25 网络过滤事件（已回退到域名）

- 现象：手机与 PC 浏览器打开 `https://<PUBLIC_DOMAIN>/...` 出现"无法显示此网页"；nginx 日志里没有手机请求（未到服务器）。
- 定位：同 IP 换 SNI（`example.com`）正常 200，`<PUBLIC_DOMAIN>` 的 TLS 握手被 RST（80/443/22 端口一致）；海外与香港探测节点全部 200。属网络侧按 SNI/指纹的连接重置，非服务器或代码问题。
- 现状态：配置**已全部回退为域名**。Node/OpenSSL 客户端（隧道、插件、自动化测试）与 Chromium 内核可正常访问；Windows curl（Schannel）与部分手机浏览器仍会被重置，说明过滤是间歇/按客户端指纹生效的。
- 应急方案（IP 直连，代码已支持，只改 `.env`）：
  - `.env`：`RELAY_URL=wss://<服务器IP>/dsh-tunnel`、`PUBLIC_PAIR_URL=https://<服务器IP>/dsh-pair`、`DSH2PHONE_ALLOW_INVALID_CERT=1`
  - 已安装的 Startup 副本 `dsh2phone-tunnel.vbs` 自带 `RELAY_URL` 会覆盖 `.env`，要一起改（或删掉它的 `Environment("PROCESS")` 行）
  - 代价：手机首次访问会出现证书不匹配提示（证书签给域名）；浏览器访问 IP 不发 SNI，因此不会被 SNI 规则命中。**2026-10-27 复核**：Let's Encrypt 已支持 IP 证书（6 天短周期，certbot ≥5.4），可消除该提示并避免关校验；详见 `docs/ip-feasibility.md`。
- 改完配置后务必**重新安装插件并切换一次启用状态**，否则运行中的 Service 仍用旧配置（旧实例不会因 patch 变更自动重建）。

### 2026-10-27 隧道静默断链（已修复）

- 现象：手机扫码后页面显示"电脑上的隧道暂时没有连上"（relay 数据面在 `tunnel` 不在线时返回 503 降级页；`/dsh-pair` 也走这条判断）。
- 根因：PC 端 node 隧道进程（pid 36168，10-25 05:12 启动）在 01:25 之后不再写日志；链路是**静默半开**（没有 RST/close 事件），`ws` 的 `close` 永远不触发 → 进程卡在 `online` 状态，而 supervisor（VBS 的 `Do While` 循环）因为子进程不退出也无法重启。relay 侧 05:54 因 pong 超时踢掉连接，但客户端毫无感知。
- 修复：`tunnel/src/tunnel.mjs` 的 run 模式加**心跳看门狗**：每 15s 检查，超过 70s 没有任何入站流量（`ping`/`pong`/`message` 都会刷新）就 `ws.terminate()` 强制重连，进程不会再有"卡死但 supervisor 不重启"的状态。
- 恢复步骤：`Stop-Process` 掉卡住的 node 后，VBS supervisor（pid 47748）5s 内自动重启，日志出现 `relay online`；服务器 `healthz` 为 `tunnel:online`。
- 验证：用本机铸造的设备 cookie（`dshdev` 用 `deploy/server/tunnel.key` HMAC）+ DSH cookie 请求 `https://<PUBLIC_DOMAIN>/dsh/` 返回 **200**（43KB，含 `__DSH_BOOT__`），说明 relay 门禁、数据面、隧道、DSH 全链路正常。
- 提醒：排查期间曾临时用任务计划程序建过同名任务（用于脱离沙箱会话），**已删除**；自启仍只由 Startup 文件夹的 `dsh2phone-tunnel.vbs` 负责，避免两个 supervisor 争抢同一条隧道连接。

### 2026-10-27 深色/浅色适配审查（已修）

- 现象：深色模式下配对确认框的"允许接入"按钮白字白底。原因是 `.d2p-btnPrimary` 用了 `color:#fff`，而 `--dsw-alias-brand-primary` 在深色主题是 `#f9fafb`（浅色）。
- **填色控件规则**：底色 `--dsw-alias-brand-primary`，文字必须 `--dsw-alias-label-primary-inverted`（浅色=#fff，深色=#353638）。hover 用 `color-mix(... brand 88%, label-inverted)`，不要用 `filter:brightness()`（近白底上看不出变化）。
- **表面色规则**：对话框/卡片用 `--dsw-alias-bg-layer-1`（浅 #fff / 深 #232324）。不要用 `--dsw-alias-bg-overlay`（浅 #e9ecf2 / 深 #61666b，是遮罩/浮层色：深色下卡片发灰，白字只有 5.5:1）。次级按钮 hover、选中 tab 用 `label-primary × 8–10%` 的 color-mix，两种主题都可见。
- **状态色对比度**：`state-success-primary`（#22c55e）在白底只有 ~1.9:1，11px 徽标读不清。徽标/成功文案改为 `color-mix(state 60%, label-primary)`：浅色变深、深色变亮，实测 4.68:1（浅）/ 7.51:1（深）。
- **手机侧 relay 页面**：403「未知设备 / 已停用 / token 拒绝」页原先没有 `color-scheme`，深色手机上是刺眼白屏。已补 `:root{color-scheme:light dark}` + 深色媒体查询，hint 从内联 `#666` 改成 `.hint{opacity:.72}`，`theme-color` 按媒体查询给两档。入口页/等待页/503 页原本已有深色适配，未改。
- **验证工具**：`tools/plugin-theme-check.mjs`（真实 GUI 明/暗截图 + 计算对比度；模拟手机发配对请求后点"拒绝"，不会留下设备）、`tools/relay-pages-theme-check.mjs`（本地 relay，假隧道，渲染 403/503 页）。截图在 `docs/theme/`。
- 实测对比度：主按钮 **18.9:1（浅）/ 11.6:1（深）**；对话框正文 18.9 / 15.0；设备徽标 4.68 / 7.51；次要说明 5.8 / 10.4。
- relay 已重新部署（`docker compose up -d --build dsh-relay`，上传前 md5 校验 = `890373003c90c223a6d0ee243beb2826`，`healthz` 为 `tunnel:online`）。
- 插件 `client.js` 的改动**刷新页面即生效**（bundle revision 按 mtime/size 计算），无需重启 Desktop。

### 2026-10-27 IP 入口可行性评估（新增）

- 结论：功能已实测可行（IP 直连 `/dsh/` 带设备/DSH cookie 返回 200、43KB；`/dsh-pair` 200；未配对 `/dsh/` 403），但现有域名证书不含 IP，裸切会出现证书警告。
- 长期方案：LE IP 证书（`shortlived`，约 6 天，certbot ≥5.4）+ 443 `default_server`；推荐“域名主 + IP 备”双栈，只把手机入口 `publicKeyUrl` 切 IP，PC 控制面留域名。
- 硬约束：`authority` 必须保持 `127.0.0.1:43120`；nginx 的 `Host`/`Origin` 不要动；无有效 IP 证书时不要长期使用 `TUNNEL_INSECURE=1` / `allowInvalidCert: true`。
- 详细数据、命令、验证清单见 `docs/ip-feasibility.md`；nginx 示例见 `deploy/nginx/server-ip.conf.example`。

### 2026-10-27 配对去重（已修）

- 现象：同一台手机重复扫码，每次都会在白名单里新增一条一模一样的设备。
- 根因：设备 cookie `dshdev` 是 `SameSite=Strict`，而扫码是从相机/其他 App 打开的**跨站顶层导航**，浏览器不会带上它 → relay 拿不到身份，每次配对都新注册一条；同时每次配对由 PC 端生成新的 `randomUUID`，天然不复用。
- 修复（`relay/src/relay.mjs` 的 `handlePair`）：
  1. `dshdev` 改 `SameSite=Lax`（HttpOnly 不变；DSH 自己的 `dsh-auth-*` 仍是 Strict）——扫码时能带上身份。
  2. 带 code 时不再对已配对设备直接返回入口页，而是照常走 `pair.request` 确认（顺带让 PC 铸造新的 DSH cookie），确认后**复用**该设备 id、保留 `createdAt`。
  3. 兜底去重：没有有效 cookie 时按 `ua` 精确匹配已有设备并复用（覆盖 cookie 被清、in-app 浏览器、以及旧 Strict cookie 尚未刷新的一次性场景）。
  4. `pair.request` 增加可选 `existing:{id,name}`；插件确认框多一行"该设备已在白名单，确认后将刷新授权。"（host.js 改动需重启 Desktop 生效，relay 去重不依赖它）。
- 边界：不同 UA 的设备仍各自一条（不做模糊合并，避免把两台同型号设备合成一台）；同 UA 但其实是两个浏览器的情况会被合并，属于可接受的取舍（撤销时一起撤销更安全）。
- 验证：`tools/relay-dedupe-check.mjs`（本地 relay：首次 1 条 → 带 cookie 复用 → 无 cookie 按 UA 复用 → 换 UA 才新增，`ok:true`）；`tools/plugin-dedupe-check.mjs`（真 GUI + 生产 relay：两次配对后仍是同一条、返回同一个 `dshdev`、测试设备自动清理）。
- 清理：注册表里 22:37 与 22:57 同 UA 的陈旧重复条目（22:41 后不再活跃）已删除；当前保留 2 台（`Android 16 Chrome` 10-25、`Android 10 Chrome` 10-27）。

### 2026-10-27 23:00 域名在用户侧失效 → 执行 IP 应急预案

- 现状：从本机 23:02 看域名仍解析到 `<SERVER_IP>` 且 `/dsh-pair` 200，`tunnel.log` 有 `relay online`、`healthz` 为 `tunnel:online`；用户手机侧只能走 IP。
- 先执行 `docs/ip-emergency-plan.md` 的 **P0-A**：只把 `.env` 的 `PUBLIC_PAIR_URL` 改成 `https://<SERVER_IP>/dsh-pair`，PC 控制面继续走域名；重装插件后手机用 Chrome 重新配对。
- 若 PC 侧域名也不可用：执行 **P0-B**（`.env` 的 `RELAY_URL` 全切 IP + 临时 `DSH2PHONE_ALLOW_INVALID_CERT=1`），再做 P1。
- P1 签 IP 证书后换证书即可，**origin 不变、无需二次配对**；P0-B 的临时关校验必须关闭。
- ⚠️ 设备去重：relay 会按 UA 复用已有设备，IP 配对可能不新增条目；不要按“旧域名设备”误删，否则会吊销当前手机。

---

## 八、隐私与配置边界（2026-10-27 整理）

**唯一配置入口**：`<repo>/.env`（模板 `.env.example` 入库）。`shared/env.mjs` 在启动时加载它，真实环境变量优先。
`tunnel/*.cmd` 只设置 `DSH2PHONE_ENV_FILE`；`cordis.patch.yml` 的 `config` 为空；`relay.mjs` 在本地运行时也会尝试加载 `.env`（容器里用 compose 的 `env_file`）。

| 曾经硬编码的位置 | 现在 |
|---|---|
| `tunnel/{start,pair,devices}.cmd` 的 `DSH_TUNNEL_KEY=` / `RELAY_URL=` | `.env` |
| `dsh2phone-dsh-plugin/host.js` 的 `relayUrl/publicKeyUrl` 默认值 | `.env` 的 `RELAY_URL` / `PUBLIC_PAIR_URL` |
| `cordis.patch.yml` 的 `relayUrl/publicKeyUrl/keyFile/allowInvalidCert` | `.env`（YAML 只剩本机绝对入口路径，且已忽略） |
| `tunnel/src/tunnel.mjs` 的 `PUBLIC_PAIR_URL` 默认域名 | `.env`（缺失时报错而不是静默走公网） |
| `tools/*.mjs` 的生产域名、`C:\Users\…` 应用路径、`deploy/server/tunnel.key` 相对路径 | `.env` 的 `PUBLIC_PAIR_URL` / `RELAY_URL` / `DSH_APP_DIR` / `DSH_TUNNEL_KEY` |
| `deploy/nginx/server-ip.conf.example` 的真实 IP、`deploy/diag-firewall.ps1` 的绝对输出路径 | `<SERVER_IP>` 占位符 / `$PSScriptRoot` |
| `docs/*.md` 的域名、服务器 IP、SSH 账号与私钥、本机路径 | `<PUBLIC_DOMAIN>` / `<SERVER_IP>` / `<SSH_USER>` / `<SSH_KEY>` / `<REPO_DIR>` 占位符 |

**已忽略（`.gitignore`）**：`.env` / `.env.*`（保留 `.env.example`）、`dsh2phone-dsh-plugin/cordis.patch.yml`、`tunnel/autostart.vbs`、`*.key` `*.pem` `deploy/tls/`、`deploy/server/tunnel.key`、`.e2e-jar.txt`、`.e2e-state/`、`.plugin-smoke-state/`、`*state/devices.json`、`*.log`、`deploy/*.out.txt`。

**脱敏截图**：`docs/` 下 9 张 GUI 截图已模糊侧栏（工作区/会话名、账号手机号）并遮盖二维码（内含公网 URL 与配对码）。重新跑 `plugin-gui-check.mjs` / `plugin-theme-check.mjs` 生成新图后，必须再跑 `python tools/redact_screenshots.py`。

**仍需注意**：
- 截图设备卡片里的 `IP 172.20.0.4`（内网/VPN 地址）与时间戳保留可见，属于演示所需；如需彻底隐藏请再扩 `QR_SHOTS` 之外的遮盖区域。
- `deploy/server/tunnel.key` 仍在本机磁盘（旧的 Startup VBS 会读它）。`.env` 已含同一密钥；迁移到 `tools/render-plugin-patch.mjs` + 新 VBS 模板后可以删除该文件。
- 已安装的 Startup 副本 `dsh2phone-tunnel.vbs` **自带** `RELAY_URL`/`DSH_TUNNEL_KEY`，会覆盖 `.env`；改 `.env` 后要么同步改它，要么删掉那几行让它只读 `.env`。
- 仓库首次推送前（`origin` 尚无任何提交），密钥从未进入 Git 历史；若曾把 `.env`/`tunnel.key` 推送到别处，应按泄露处理并轮换 `DSH_TUNNEL_KEY`（relay 里它是设备 cookie 的 HMAC 密钥）。
