# dsh2phone：手机通过公网连接 DSH —— 技术方案 v2

> 日期：2026-10-22（v2：含服务器实测数据与 Agents Anywhere 发现）
> 状态：待最终拍板
> 已确认决策：DSH Desktop 形态 · 手机浏览器 · 允许分阶段交付 · 倾向 nginx 路径后缀转发
>
> ⚠️ 已脱敏：域名 → `<PUBLIC_DOMAIN>`、服务器 IP → `<SERVER_IP>`、SSH 账号/私钥 → `<SSH_USER>` / `<SSH_KEY>`。真实值见本机 `.env`（已忽略）。

## 1. 重大发现：已有开实现覆盖全部需求 —— Agents Anywhere

[anywhere-labs/Agents-Anywhere](https://github.com/anywhere-labs/Agents-Anywhere)（MIT，v2.0.3）是 DSH Desktop 同一团队（anywhere-labs）的开源跨设备 Agent 工作台：

- **功能完全覆盖目标**：查看/管理会话、时间线进度、回复 Agent 请求、工具审批（单次批准/拒绝）、打断/继续、文件浏览、附件上传、远程终端；支持 DSH、Codex、Claude Code。
- **DSH 集成方式就是本机已装插件**：`@agents-anywhere/dsh-bridge-next`（Desktop 的 optional bundle）。你的 desktop profile（`~/.dsh/profiles/desktop/package.json`）**已经启用该 bundle**，侧栏「远程控制」即其入口。
- **官方自托管支持**：`docker/docker-compose.postgres.yml` 一键起 PostgreSQL 17 + Redis 8 + 迁移 + FastAPI Server（同源托管 Web 控制台，端口 5174）；`AGENT_SERVER_PUBLIC_ORIGIN` 支持反向代理后的公网 origin。
- **客户端**：手机浏览器 Web App、Android APK、iOS App Store / TestFlight；手机扫码配对（插件内嵌二维码）。
- 数据：会话内容/Timeline/附件存储在 Server（自托管即存于自己的 PostgreSQL），符合"服务器中转用 XiaoniuTech"的要求。

### 与原"自研透明隧道"方案的关系

| | Track A：自托管 Agents Anywhere | Track B：自研透明隧道（原方案阶段 1） |
|---|---|---|
| 手机端体验 | 原生级移动 UI（Web App / App） | 完整 DSH 桌面 GUI（手机 UX 一般） |
| 开发量 | 几乎为零（部署 + 配置） | relay + tunnel ≈ 2–4 天 |
| 服务器负载 | +PostgreSQL +Redis +AA Server（约 +400~600MB） | +1 个小 Node 容器（~50MB） |
| 账号体系 | AA 账号（自建管理员） | 无（DSH token 即凭据） |
| nginx 入口 | **需要子域名**（Web 为同源静态导出，不支持路径前缀） | 可用路径前缀 `/dsh/`（DSH 官方支持 `publicUrl` 前缀） |
| 额外能力 | 审批、推送、多设备、多 Agent（Codex/Claude Code） | 仅 DSH GUI 已有能力 |

**推荐：Track A 为主**（现有实现、体验最好、零开发）；Track B 作为可选补充（给完整桌面 GUI 一个公网入口）。

## 2. 服务器实测（2026-10-22 探测）

SSH：`<SSH_USER>@<SERVER_IP>`（<PUBLIC_DOMAIN>，密钥 `<SSH_KEY>`）。

| 项目 | 现状 |
|---|---|
| 系统 | Ubuntu（kernel 6.8），内存 **1.6Gi**（可用 ~868Mi），swap 2Gi，磁盘 40G（余 15G） |
| 容器 | `nginx`（80/443）、`backend`（Express，3001）、`mongodb`（mongo:7，27017） |
| 项目根 | `/usr/local/compose`（compose 文件、`conf/nginx`、`www`、`data/backend`、`bak`、`.env`） |
| nginx | `conf.d/server.conf`：80→301、443 SSL（<PUBLIC_DOMAIN> + www）；`include conf.d/*.location` 挂 location（`chat.location` 含 WS upgrade/SSE 模板，可直接仿写）；另挂宿主机 `/etc/nginx/conf.d/*.location` |
| 证书 | certbot 2.9.0；Let's Encrypt 仅覆盖 `<PUBLIC_DOMAIN>` + `www.<PUBLIC_DOMAIN>`（2026-12-07 到期），**无泛域名** |
| DNS | `<PUBLIC_DOMAIN>` / `www.<PUBLIC_DOMAIN>` → <SERVER_IP>；`aa.<PUBLIC_DOMAIN>` 未建记录 |
| 宿主机其他服务 | dovecot/postfix/spamd（邮件）、redis（127.0.0.1，邮件栈用，勿动） |
| ⚠️ 安全隐患（顺带发现） | **mongodb 27017 与 backend 3001 直接暴露 0.0.0.0 公网**，建议改绑 127.0.0.1 |

## 3. Track A 实施计划：自托管 AA 到 <PUBLIC_DOMAIN>

### 3.1 架构

```
手机浏览器/App ──HTTPS──► aa.<PUBLIC_DOMAIN> (nginx:443) ──► 127.0.0.1:5174 (AA Server 容器)
                                                              ▲  WSS 长连接(出站)
DSH Desktop(本机) ─插件 dsh-bridge-next + Connector───────────┘
```

### 3.2 步骤

1. **DNS（需你在域名控制台操作）**：新增 `aa.<PUBLIC_DOMAIN>` A 记录 → `<SERVER_IP>`。
2. **证书**：`certbot` 签 `aa.<PUBLIC_DOMAIN>`（webroot 复用现有 acme-challenge 配置），nginx 新增 `aa.conf` server block：
   - 443 SSL → `proxy_pass http://127.0.0.1:5174`；WebSocket upgrade 头；`proxy_read_timeout` 调大（Connector 心跳 20s，建议 3600s）；client_max_body_size 调大（附件上传）。
3. **部署 AA**（compose project `agents-anywhere`，与现有 `compose` 项目并存）：
   - 服务器上 `git clone https://github.com/anywhere-labs/Agents-Anywhere`（或本机打包上传）；
   - `AGENTS_ANYWHERE_WEB_PORT=5174` 绑 127.0.0.1；`POSTGRES_PASSWORD` / `AGENT_SERVER_SECRET` 强随机；`AGENT_SERVER_PUBLIC_ORIGIN=https://aa.<PUBLIC_DOMAIN>`；`AGENT_SERVER_CORS_ORIGINS=https://aa.<PUBLIC_DOMAIN>`；
   - 构建用国内镜像 build args（`APT_MIRROR`/`PIP_INDEX_URL`/`YARN_REGISTRY`）。
   - ⚠️ **构建与运行内存**：ECS 仅 1.6Gi。Next.js 静态导出构建可能接近内存上限（建议临时加 swap 或在本机 Docker 构建后 `docker save | ssh docker load`）；运行期预计常驻 +400~600MB，建议** ECS 升配到 2Gi+**，或观察 swap 使用情况再说。
4. **初始化**：`docker logs` 取 bootstrap/setup token → Web 创建首位管理员。
5. **本机接入**：DSH Desktop → 侧栏「远程控制」→ 连接到自己的服务实例 `https://aa.<PUBLIC_DOMAIN>` → Web 登录授权 → Connector 上线（插件已装，已验证 bundle 启用）。
6. **手机接入**：浏览器打开 `https://aa.<PUBLIC_DOMAIN>` 登录（可加主屏幕）；或装 AA Android/iOS App 填自建地址。
7. **顺手加固**：mongodb/3001 端口收回 127.0.0.1；AA 的 PG/Redis 不暴露宿主机端口（compose 默认即不暴露）。

### 3.3 验证清单

- [ ] `https://aa.<PUBLIC_DOMAIN>` 可打开 Web 控制台并注册管理员
- [ ] DSH 插件连接自建服成功、设备在线
- [ ] 手机浏览器可见 DSH 会话、实时刷新、可发消息/审批
- [ ] Connector 断线重连（PC 休眠恢复）正常

## 4. Track B（可选补充）：透明隧道暴露完整 DSH GUI

沿用 v1 方案阶段 1：自研 WSS 中继容器（`location /dsh-relay/`）+ 本机 tunnel 客户端；DSH Desktop 配置 `trustedHosts: ["<PUBLIC_DOMAIN>"]` + `publicUrl: https://<PUBLIC_DOMAIN>/dsh/`；手机扫码带 token URL 直接用完整 GUI。**仅在不想运行 AA 整套栈时采用**。

## 5. 待拍板

1. Track A / Track B / 两者都做？（推荐 A）
2. 若 A：可否添加 `aa.<PUBLIC_DOMAIN>` DNS 记录？（只能你操作）
3. ECS 是否可临时升配（或接受先用 swap 跑）？
4. 是否顺手修复 mongodb/3001 公网暴露？
