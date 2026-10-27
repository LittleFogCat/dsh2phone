# dsh2phone

让手机通过公网访问**本机 DSH Desktop 的 Web GUI**：一个自托管 WSS 中继 + 本机出站隧道 + 设备白名单 + 一次性配对码，token 与密钥都不出本机。

```
手机浏览器 ──HTTPS──► nginx(<PUBLIC_DOMAIN>:443)
                        │  /dsh/       → dsh-relay:3200（剥前缀，Host 固定 127.0.0.1:43120，剥 Origin）
                        │  /dsh-pair   → dsh-relay:3200/pair（配对端点 + 已配对设备入口页）
                        │  /dsh-tunnel → dsh-relay:3201/tunnel（控制面 WSS）
                        ▼
                   dsh-relay 容器（设备门禁 + 注册表 + 配对 + 多路复用）
                        ⇕ WSS（PC 主动出站，VBS/服务守护）
                   tunnel（本机 Node）──loopback──► DSH Desktop webserver 127.0.0.1:43120
```

手机侧看到的永远是"一个已经登录的 DSH"：cookie 由本机离线铸造，公网链路上只有设备 cookie。

## 特性

- **设备白名单门禁**：relay 窥视每个 HTTP 头，要求 `dshdev=<uuid>.<HMAC>` 且注册表 `status=allow`，否则 403
- **token 永不上公网**：带 `?token=` 的请求一律 403；DSH cookie 在本机铸造后随配对响应下发
- **一次性配对**：5 分钟配对码 → 手机访问 `/dsh-pair` → 电脑端弹窗确认 → 注册设备并下发 cookie
- **即时吊销**：设备列表 / 单台停用 / 删除 / 全部吊销（panic），对公网立即生效
- **穿透友好**：PC 只做出站 WSS，无需公网 IP、端口映射或反向代理到本机
- **可复现验证**：本地 relay + 假隧道 + 真 GUI 的端到端脚本都在 `tools/`

## 组成

| 目录 | 作用 | 入口 |
|---|---|---|
| `relay/` | 公网中继：设备门禁、配对端点、控制面、TCP 多路复用（Docker 部署） | `relay/src/relay.mjs` |
| `tunnel/` | 本机隧道：出站 WSS、配对 CLI、设备管理、cookie 铸造 | `tunnel/src/tunnel.mjs` |
| `dsh2phone-dsh-plugin/` | DSH Desktop 插件：账号菜单里的"配对手机"二维码弹窗 + 设备管理 | `host.js` / `client.js` |
| `deploy/` | nginx location、服务器 compose、IP 入口示例、本地仿真代理 | `deploy/nginx/`、`deploy/server/` |
| `shared/` | 唯一配置入口：加载 `.env` | `shared/env.mjs` |
| `docs/` | 交接文档、IP 应急方案、可行性评估（均已脱敏） | `docs/HANDOFF.md` |
| `tools/` | 自检与验证脚本 | 见下表 |

## 快速开始

### 0. 前置

- Node.js ≥ 20（推荐 22，与 relay 镜像一致）
- 本机已安装并能运行 **DSH Desktop**（Web GUI 监听 `127.0.0.1:43120`）
- 一台有公网域名/IP 的服务器（nginx + Docker），用来跑 relay

### 1. 配置

```powershell
Copy-Item .env.example .env
```

至少填写：`RELAY_URL`、`PUBLIC_PAIR_URL`、`DSH_TUNNEL_KEY`（`node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"` 生成）。
自检：

```powershell
npm run check-env     # 密钥打码显示；缺必填项时退出码 1
```

配置项含义见[下文](#配置项)。

### 2. 本地跑通（可选，不碰公网）

两个独立检查，按需选用：

```powershell
# A. 只看"前缀剥离 + DSH 信任栅栏"（直连 43120，不经过 relay）
node tools/gen-cert.mjs                         # 生成 deploy/tls 自签证书（已忽略）
node deploy/prefix-test.mjs                     # 打开 https://127.0.0.1:9443/dsh/?token=<本机 token>

# B. 只看 relay 协议与配对流程（本地起 relay + 假隧道，不发真实请求）
npm run relay                                   # :3200 数据面 / :3201 控制面
npm test                                        # = check-env + plugin-config-check + plugin-smoke（自动在 13200/13201 起 relay）
```

完整链路（relay + tunnel）需要 nginx 或等效代理把 `/dsh/` 转到 relay 的 3200，见下一节。

### 3. 部署 relay（服务器）

```bash
# 服务器上：仓库 deploy/server/ 为 compose 目录
cd /usr/local/compose && $EDITOR .env           # 至少 DSH_TUNNEL_KEY，与本机 .env 一致
docker compose up -d --build dsh-relay
docker exec dsh-relay wget -qO- http://127.0.0.1:3201/healthz   # tunnel:offline → 启动隧道后 online
```

nginx 需要三条 location（`/dsh-tunnel`、`/dsh-pair`、`/dsh/`），见 [`deploy/nginx/dsh.location`](deploy/nginx/dsh.location)。
**关键约束**：`proxy_set_header Host 127.0.0.1:43120;` 与 `proxy_set_header Origin "";` 不能改，DSH 的信任栅栏靠它放行。

### 4. 安装 DSH 插件

```powershell
plugin_manager install_bundle target=<REPO_DIR>\dsh2phone-dsh-plugin
```

装好后 DSH 左下角**账号菜单**里出现"配对手机"。`cordis.patch.yml` 直接入库（入口写成相对的 `./host.js`，由 loader 按 patch 文件位置解析），**不需要任何生成脚本**，换机器/换目录都能用。

配置不全时点开"配对手机"会自动切到**设置**标签，就地填写并保存即可（不需要手改 `.env` 或重启）。

### 5. 配对手机

1. 电脑 DSH → 账号菜单 → "配对手机" → 出现二维码（内容 = `PUBLIC_PAIR_URL?code=...`）
2. 手机扫码 → 电脑弹确认框（设备名 / IP）→ 允许
3. 手机看到"配对成功 / 进入 DSH"入口页 → 点"进入 DSH" → 浏览器菜单"添加到主屏幕"

CLI 备用：`node tunnel/src/tunnel.mjs pair`（二维码打在终端 + Y/n 确认）。

### 插件里的「设置」标签

弹窗有三个标签：**配对 / 设备管理 / 设置**。

| 功能 | 说明 |
|---|---|
| 连接信息表单 | `RELAY_URL`、`PUBLIC_PAIR_URL`、隧道密钥（可显示/隐藏、一键生成）、`authority`、cookie 有效期、跳过证书校验 |
| 保存并应用 | 直接改写 `<repo>/.env`（保留原有注释与顺序），立即生效；被启动器导出的真实环境变量覆盖时会明确提示 |
| 测试连通性 | 三段独立检测：本机 DSH、relay 控制面（顺带返回已配对设备数）、公网配对页，各自给出耗时/HTTP 状态/错误 |
| 部署命令 | 服务器侧 `docker compose` + `nginx -t` 命令，一键复制（插件不会替你 SSH） |

配置缺失或仍是 `.env.example` 占位值时，配对页不会再报死胡同错误，而是自动跳到设置并高亮缺哪几项。

## 配置项

所有配置集中在 `.env`（已被 `.gitignore` 忽略），代码里不出现域名、IP、密钥或本机路径。

| 变量 | 说明 |
|---|---|
| `RELAY_URL` | 控制面 WSS，如 `wss://<PUBLIC_DOMAIN>/dsh-tunnel` |
| `PUBLIC_PAIR_URL` | 配对页地址，二维码内容 = 它 + `?code=…` |
| `DSH_TUNNEL_KEY` | 隧道共享密钥，**必须与服务器 `/usr/local/compose/.env` 一致**；也是设备 cookie 的 HMAC 密钥 |
| `DSH2PHONE_ALLOW_INVALID_CERT` | `1` = 跳过 relay 证书校验（relay 用 IP 直连但证书是域名时，仅应急） |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` | 本机 DSH Web 服务，默认 `127.0.0.1:43120` |
| `DSH_AUTHORITY` | DSH 看到的 Host 头，也是铸造 cookie 的 authority，**保持 `127.0.0.1:43120`** |
| `DSH2PHONE_TTL_DAYS` | 铸造的 DSH cookie 有效期，默认 30 天 |
| `DSH_CREDENTIALS_FILE` | 留空 = `~/.dsh/.credentials.yaml`（只读其中的 browser-session secret） |
| `DSH_APP_DIR` | DSH Desktop 安装目录（插件从这里的 `@deepseek-ai/*` 解析原生类） |
| `DSH2PHONE_HOME` / `DSH2PHONE_KEY_FILE` | 本机路径；`DSH2PHONE_KEY_FILE` 为空时用 `DSH_TUNNEL_KEY` |
| `RELAY_DATA_PORT` / `RELAY_CONTROL_PORT` / `RELAY_STATE_DIR` / `RELAY_PUBLIC_PREFIX` | relay 运行时（服务器由 compose 提供） |
| `DSH2PHONE_DOMAIN` / `DSH2PHONE_SERVER_IP` / `DSH2PHONE_SSH_*` | 仅文档与 nginx 模板引用 |

真实环境变量优先于 `.env`，便于临时覆盖：`$env:RELAY_URL='wss://…'; npm run tunnel`。
例外：插件「设置」保存后会立即写回本进程（否则"保存并应用"要重启才生效）；由启动器导出的变量仍会覆盖，并在界面上提示。

## 常用命令

```powershell
npm run check-env                      # 配置自检
npm run relay                          # 本地起 relay
npm run tunnel                         # 隧道主进程
npm test                               # check-env + plugin-config-check + plugin-smoke

node tunnel/src/tunnel.mjs pair        # 配对（终端二维码 + 确认）
node tunnel/src/tunnel.mjs devices     # 设备列表
node tunnel/src/tunnel.mjs deny <id>   # 拉黑 / allow / remove / panic
```

启动脚本：`tunnel/start.cmd`、`tunnel/pair.cmd`、`tunnel/devices.cmd`（只设置 `DSH2PHONE_ENV_FILE`，密钥从 `.env` 读）。
开机自启见 [`tunnel/autostart.vbs.example`](tunnel/autostart.vbs.example)。

### 验证脚本

| 脚本 | 覆盖 | 需要 |
|---|---|---|
| `tools/plugin-smoke.mjs` | relay 协议 + 配对 + 设备注册 + deny/remove（本地） | 无 |
| `tools/plugin-config-check.mjs` | 设置页回归：缺配置→configRequired、占位符识别、写 `.env` 保注释、probe 三段 | 无 |
| `tools/gate-repro.mjs` | 门禁逻辑离线复现（真密钥 + 假隧道） | `.env` |
| `tools/relay-dedupe-check.mjs` | 配对去重（本地 relay） | 无 |
| `tools/relay-pages-theme-check.mjs` | relay 403/503/入口页深色浅色 | 无 |
| `tools/gen-cert.mjs` | 生成本地自签证书（`deploy/tls/`） | 无 |
| `tools/plugin-host-identity-check.mjs` | 插件 host 用 DSH 原生 `@deepseek-ai/*` 加载 | DSH 已安装 |
| `tools/plugin-gui-check.mjs` | 账号菜单入口 / 二维码 / 设备页 | DSH 运行 + Edge |
| `tools/plugin-gui-entry-check.mjs` | 入口位置、键盘可达、Esc/点外关闭 | DSH 运行 + Edge |
| `tools/plugin-gui-settings.mjs` | 插件在设置页的启用状态 | DSH 运行 + Edge |
| `tools/plugin-theme-check.mjs` | 明暗主题对比度 + 截图（`docs/theme/`） | DSH 运行 + Edge |
| `tools/plugin-e2e-pair.mjs` | 真 GUI + 公网 relay 全链路配对 | 公网可达 |
| `tools/plugin-e2e-gate.mjs` | 公网门禁 200→403→200→403 | 公网可达 |
| `tools/plugin-dedupe-check.mjs` | 公网重复扫码不新增设备 | 公网可达 |
| `tools/gui-e2e.mjs` | 手机尺寸视口下的 GUI 冒烟（截图 `docs/gui-e2e.png`） | DSH 运行 + Edge |

GUI 类脚本通过 Playwright 驱动本机 Edge（`channel: "msedge"`）访问 `http://127.0.0.1:43120`，并用 `~/.dsh/.credentials.yaml` 里的 secret 现场铸造登录 cookie。

## 安全模型

1. **设备白名单**：`dshdev=<uuid>.<HMAC-SHA256(key,uuid)>`，签名不对或 `status!=allow` → 403
2. **token 作废**：`?token=` 直接 403（token 只在局域网链路出现）
3. **配对制**：配对码 5 分钟一次性；确认只在 PC 侧完成，公网无法自助接入
4. **吊销**：deny / remove / panic 通过控制面即时生效

**DSH cookie 铸造**（勿改格式）：

```
payload  = {version:1, authority, issuedAt, expiresAt}
value    = "v1." + b64url(JSON payload) + "." + b64url(HMAC-SHA256(secret, body))
name     = "dsh-auth-" + b64url(sha256(authority))
属性      = Max-Age=<秒>; Path=/; Expires=<UTC>; HttpOnly; SameSite=Strict
secret   = ~/.dsh/.credentials.yaml 中 client-connection/browser-session 的 payload.secret
```

## 版本与发布

插件版本写在 `dsh2phone-dsh-plugin/package.json`（DSH 插件管理器显示的就是它）与根 `package.json`，变更记录见 [`CHANGELOG.md`](CHANGELOG.md)（最新版本在该文件顶部，插件「设置」页底部也会显示）。

**每次推送都必须升级版本**：`tools/version-check.mjs` 以 pre-push 钩子强制检查（`npm run prepare` 安装；应急 `git push --no-verify`）。

```powershell
node tools/version.mjs bump patch --note "修复 xxx"   # 改两处版本号 + 在 CHANGELOG 顶部插入条目
node tools/version-check.mjs                        # 自检（版本已升 / 条目存在 / 无 TODO 占位）
git tag v1.1.1 && git push origin v1.1.1             # 可选：打 tag
```

升级幅度怎么选：

| 幅度 | 什么时候用 | 例子 |
|---|---|---|
| **major** | 已配对设备或部署需要人工干预 | cookie 格式变化、relay 协议不兼容、配置键重命名、必须重装插件 |
| **minor** | 新增向后兼容的能力 | 新标签、新 Remote 方法、新设置项、新的默认行为 |
| **patch** | 修复与打磨 | bug 修复、UI/文案、依赖升级、文档与工具 |

升级插件：重新 `install_bundle` 后重启 Desktop；装好后在「设置」页底部可以看到当前版本，方便核对。

## 隐私与仓库卫生

- `.env`、`*.key`、`*.pem`、`*.log`、`.e2e-jar.txt`、设备注册表、`autostart.vbs` 全部在 `.gitignore` 内；`git add -A` 前建议先 `git add --dry-run --all` 扫一眼
- `docs/` 的域名/IP/SSH/本机路径已替换为 `<PUBLIC_DOMAIN>` 等占位符，真实值只在 `.env`
- `docs/*.png` 已脱敏（侧栏模糊 + 二维码遮盖）；**重新生成截图后必须执行**：

  ```powershell
  python tools/redact_screenshots.py
  ```

## 排障

| 现象 | 检查 |
|---|---|
| 手机 403"未知设备" | 设备是否已配对/被停用；relay 注册表 `state/devices.json` |
| 手机 403"设备已被停用" | 插件设备页点"启用"，或 `tunnel.mjs allow <id>` |
| 手机 503"电脑端连接中" | 隧道没在线：看 `tunnel.log` 是否有 `relay online`，服务器 `healthz` |
| `pair.start` 超时 | `RELAY_URL` 是否可达（SNI 被重置时见 `docs/ip-emergency-plan.md`） |
| 二维码是旧域名 | 改 `.env` 后要重装插件并禁用/启用一次（host 在进程内缓存配置） |
| 扫码后重复新增设备 | 正常应去重；检查手机是否换了浏览器/UA |
| 443 证书不匹配（IP 直连） | 要么签 IP 证书，要么临时 `DSH2PHONE_ALLOW_INVALID_CERT=1` |

## 目录

```
relay/            src/relay.mjs, Dockerfile
tunnel/           src/tunnel.mjs, src/dsh-cookie.mjs, *.cmd, autostart.vbs.example
dsh2phone-dsh-plugin/  host.js, client.js, relay-admin.js, dsh-cookie.js, cordis.patch.yml
shared/env.mjs    .env 加载器（唯一配置入口）
deploy/           nginx/*.location, server/docker-compose.yml, tls 自签脚本, prefix-test.mjs
docs/             HANDOFF.md, ip-emergency-plan.md, ip-feasibility.md, proposal.md, *.png
tools/            自检 / 冒烟 / e2e / 截图脱敏 / 版本管理
CHANGELOG.md      版本变更记录（每次推送必须新增条目）
```

## 文档

- [`docs/HANDOFF.md`](docs/HANDOFF.md) — 交接与实现细节（唯一的"事实来源"，改动前先读）
- [`docs/ip-emergency-plan.md`](docs/ip-emergency-plan.md) — 域名不可用时的 IP 切换预案
- [`docs/ip-feasibility.md`](docs/ip-feasibility.md) — IP 入口与证书可行性评估
- [`docs/proposal.md`](docs/proposal.md) — 最初的技术方案
- [`AGENTS.md`](AGENTS.md) — 给 AI/新贡献者的仓库约定

License: ISC
