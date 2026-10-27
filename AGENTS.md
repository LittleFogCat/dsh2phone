# AGENTS.md

给 AI 编码代理（和新贡献者）的仓库约定。**先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)** —— 它是实现细节与历史决策的唯一事实来源；本文件只讲"必须遵守什么、改完怎么验证"。

项目：把手机通过公网接进本机 DSH Desktop。成熟可用，正处于"稳定 + 打磨"阶段，不是新项目。

---

## 1. 硬性规则（违反即视为 bug）

### 1.1 配置：一切都走 `.env`

- **禁止**在代码、脚本、YAML、文档里硬编码：域名、服务器 IP、隧道密钥、SSH 账号/私钥、本机绝对路径、用户名。
- 需要配置时：
  ```js
  import { env, envFlag, requireEnv, REPO_ROOT } from "../shared/env.mjs";
  const url = env("RELAY_URL", "");           // 空串视为未设置
  ```
  `.mjs` 入口在顶部 `import "../../shared/env.mjs";`（副作用：加载 `<repo>/.env`）。
- 新增变量时**必须同步**：`.env`、`.env.example`、`tools/check-env.mjs`、README 的配置表。
- 真实环境变量优先于 `.env`（不要改成反向，大量脚本依赖这个覆盖语义）。
- `.env` 不入库；`.env.example` 只放占位符。

### 1.2 隐私：入库前先想"这行会不会泄露"

`.gitignore` 已覆盖：`.env*`（保留 `.env.example`）、`*.key`、`*.pem`、`deploy/tls/`、`deploy/server/tunnel.key`、`*.log`、`.e2e-jar.txt`、`.e2e-state/`、`.plugin-smoke-state/`、`**/state/devices.json`、`deploy/*.out.txt`、`dsh2phone-dsh-plugin/cordis.patch.yml`、`tunnel/autostart.vbs`。

新增任何"运行时产物 / 凭据 / 机器相关文件"时，同时补 `.gitignore`。提交前：

```powershell
git add --dry-run --all | Select-String '\.env$|\.key$|\.pem$|\.log$|state'
```

**截图**：`docs/` 里所有 GUI 截图必须脱敏（侧栏含工作区名/会话标题/账号手机号，二维码含公网 URL 与配对码）。用 `plugin-gui-check.mjs` / `plugin-theme-check.mjs` 重新生成截图后，**必须**重跑：

```powershell
python tools/redact_screenshots.py
```

### 1.3 不能改的契约（改了会静默断链）

| 契约 | 位置 | 原因 |
|---|---|---|
| `authority` 恒为 `127.0.0.1:43120` | `.env` `DSH_AUTHORITY`、`host.js`、`tools/*` | 它等于 DSH 看到的 Host 头；跟着公网域名改会导致铸造的 cookie 校验失败 |
| nginx 固定 `Host: 127.0.0.1:43120` + `Origin ""` | `deploy/nginx/dsh.location` | DSH 的信任栅栏只认 loopback Host |
| DSH cookie 格式（`v1.<body>.<sig>`，name = `dsh-auth-` + b64url(sha256(authority))） | `tunnel/src/dsh-cookie.mjs`、`dsh2phone-dsh-plugin/dsh-cookie.js` | 与 `@deepseek-ai/dsh-client-connection` 的实现逐字节对齐 |
| relay 控制面帧类型（`hello`/`hello.ok`/`open`/`close`/`pair.*`/`devices.*`，二进制帧 `[4B streamId BE][payload]`） | `relay/src/relay.mjs`、`relay-admin.js` | 三端共用；改动要同时改 PC 隧道、插件、e2e 脚本 |
| 设备 cookie `SameSite=Lax`、DSH cookie `SameSite=Strict` | `relay/src/relay.mjs` | 扫码是跨站顶层导航 |
| `publicKeyUrl` 语义 = 二维码内容前缀 | — | 手机按它落 origin，决定了 cookie 复用范围 |

### 1.4 插件（DSH Desktop）

- **不要**手改 profile 的 `package.json` / `cordis.patch.yml`；用 `plugin_manager install_bundle target=<REPO_DIR>\dsh2phone-dsh-plugin`。
- `cordis.patch.yml` 是**生成物**（含绝对路径），模板是 `cordis.patch.example.yml`；换目录后跑 `npm run render-plugin-patch`。`config` 必须保持空，配置全部走 `.env`。
- `host.js` 里的服务方法**不能**用 `#private` 字段/方法（cordis 用 Proxy 作 `this`，V8 品牌检查会失败）；Remote 方法用 `markRemote()` 打标。
- `host.js` 改动需**重启 Desktop** 或换文件名重装；`client.js` 改动刷新页面即生效（bundle revision 按 mtime/size 计算）。
- 账号菜单没有菜单项槽位，那行入口是 DOM 嫁接（见 HANDOFF 坑 8）；升级 DSH 后入口消失先跑 `plugin-gui-entry-check.mjs` 看 `menuRows`。

---

## 2. 架构速查

```
手机 ─HTTPS─► nginx ─/dsh/─► relay:3200 ─(WSS 多路复用)─► tunnel ─► 127.0.0.1:43120 (DSH)
                        ─/dsh-pair─► relay:3200/pair
                        ─/dsh-tunnel─► relay:3201/tunnel   ← PC 出站连这里
```

| 文件 | 职责 | 改动风险 |
|---|---|---|
| `relay/src/relay.mjs` | 门禁、配对、注册表持久化、TCP↔WS 多路复用 | 高（生产门禁） |
| `deploy/server/data/dsh-relay/src/relay.mjs` | **同一份代码的部署副本**，两边必须逐字节一致 | 高（忘记同步=线上不一致） |
| `tunnel/src/tunnel.mjs` | run/pair/devices/allow/deny/remove/panic、心跳看门狗（15s 检查 / 70s 静默重连） | 中 |
| `tunnel/src/dsh-cookie.mjs` | cookie 铸造（CLI 侧） | 低（契约固定） |
| `dsh2phone-dsh-plugin/host.js` | 8 个 Typert Remote 方法 + .env 配置 | 中 |
| `dsh2phone-dsh-plugin/client.js` | 纯前端：弹窗、账号菜单行、轮询 `pairInspect` | 中 |
| `shared/env.mjs` | `.env` 解析（无依赖） | 低（但所有端依赖它） |
| `deploy/nginx/*` | 三条 location | 高（Host/Origin 不能动） |

端口：relay 数据面 `3200`、控制面 `3201`；本机 DSH `43120`；本地仿真 nginx `9443`；tools 用 `13200/13201`、`13300/13301`。

---

## 3. 改完怎么验证（按改动择优跑）

| 改了什么 | 必跑 |
|---|---|
| `relay/src/relay.mjs`（门禁/配对） | `node tools/gate-repro.mjs` → `node tools/relay-dedupe-check.mjs` → `node tools/relay-pages-theme-check.mjs`；改了协议还要 `node tools/plugin-smoke.mjs` |
| `tunnel/*` | `node tools/plugin-smoke.mjs`（本地 relay + 假隧道全流程） |
| `host.js` | `node tools/plugin-host-identity-check.mjs` + `plugin-smoke.mjs`；再重启 Desktop 用 `plugin-gui-check.mjs` |
| `client.js` / 样式 | `plugin-gui-check.mjs`、`plugin-gui-entry-check.mjs`、`plugin-theme-check.mjs`（对比度） |
| `.env` / `shared/env.mjs` | `npm run check-env` |
| 文档截图 | `python tools/redact_screenshots.py` |
| 公网链路（可选） | `plugin-e2e-pair.mjs` → `plugin-e2e-gate.mjs` → `plugin-dedupe-check.mjs` |

一键冒烟：`npm test`（= `check-env` + `plugin-smoke`）。它会在 `13200/13201` 起一个本地 relay。

> GUI/e2e 脚本要求：DSH Desktop 正在运行（`http://127.0.0.1:43120`）、本机装了 Edge（Playwright `channel: "msedge"`）、`~/.dsh/.credentials.yaml` 存在。
> 若脚本崩溃在 `spawn EPERM`，那是沙箱禁止管道而非代码问题——把 relay 作为独立进程起（`npm run relay`）后用 `SMOKE_EXTERNAL_RELAY=1 node tools/plugin-smoke.mjs`。

**改 relay 后同步部署副本**（否则线上跑旧代码）：

```powershell
Copy-Item relay/src/relay.mjs deploy/server/data/dsh-relay/src/relay.mjs -Force
```

---

## 4. 代码风格

- ESM only：`.mjs`（Node 侧）/ `.js`（插件包，`"type": "module"`）；不要引入 CommonJS。
- 2 空格缩进、双引号、语句结尾分号；命名 `camelCase` / 常量 `UPPER_SNAKE`。
- 注释与文档用**中文**，代码标识符用英文；注释解释"为什么"，不复述"做了什么"。
- 依赖极简：root 只允许 `ws` / `qrcode` / `node-forge` / `playwright`。新增依赖前先想能否用 `node:*` 内置模块（`.env` 解析就是这么做的）。
- `tools/` 脚本是**可重复运行的验证工具**，要打印结论（`SMOKE PASS` / JSON 报告）并在失败时 `process.exit(1)`；测试数据用 `203.0.113.x` 这类文档保留地址，不要用真实 IP。
- 不要提交 `console.log` 调试残留；日志走 `[tunnel]` / `[relay]` 前缀。

---

## 5. 提交与发布

- 提交信息：`type: 中文简述`，type ∈ `feat` / `fix` / `chore` / `docs` / `refactor` / `test`；正文说明"改了什么 + 为什么 + 怎么验证的"。
- **永不提交** `.env`、密钥、真实 IP/域名、含个人信息的截图。
- 推送前：`npm run check-env`、相关验证脚本、`git add --dry-run --all` 三项都过。
- 本仓库为公开仓库：熟练使用占位符（`<PUBLIC_DOMAIN>`、`<SERVER_IP>`、`<REPO_DIR>`）。

---

## 6. 已知坑（详见 HANDOFF 第六节）

1. 工作区 link 插件在 Host 包树里不可解析 → patch 行名必须是 `file:///<abs>/host.js`。
2. client 包元数据按 `(baseUrl, loaderName)` 缓存到进程重启，解析失败缓存 `null`。
3. Remote 方法内不能用 `#private`。
4. `@deepseek-ai/*` 必须用 Host 自己的副本（`DSH_APP_DIR` + `createRequire`）。
5. 二维码在 host 端用 `qrcode` 生成 PNG dataURL，client 只渲染 `<img>`。
6. client 不 require UI primitives，只用 `--dsw-alias-*` 主题 token；弹窗走 `shell.overlay`。
7. 隧道静默半开靠心跳看门狗兜底（70s 无入站 → `terminate()` 重连）。
8. 账号菜单无槽位，入口是 DOM 嫁接；匹配条件很窄（同时有"设置"与"登录/退出登录"行）。

## 7. 环境事实

- 版本事实、历史事件、部署快照都在 [`docs/HANDOFF.md`](docs/HANDOFF.md)；不要在本文件重复写易过期的细节。
- DSH 版本、安装目录、凭据路径均来自 `.env`（`DSH_APP_DIR`、`DSH_CREDENTIALS_FILE`）——不要写死。
