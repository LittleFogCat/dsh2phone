# dsh2phone 改用 IP 访问可行性评估

> 评估时间：2026-10-27 22:40–23:00（Asia/Shanghai）
> 评估对象：dsh2phone 公网入口（`https://<PUBLIC_DOMAIN>/dsh/`、`/dsh-pair`、`/dsh-tunnel`）
> 服务器：`<SERVER_IP>`（Ubuntu 24.04，nginx 1.21.5，certbot 2.9.0）
> 关联文档：[HANDOFF.md](HANDOFF.md)、[proposal.md](proposal.md)
>
> ⚠️ 本文档已脱敏（域名 → `<PUBLIC_DOMAIN>`、服务器 IP → `<SERVER_IP>`、本机路径 → `<REPO_DIR>`），真实值只在本机 `.env`（已忽略）。
> 文中“改 `cordis.patch.yml` / `pair.cmd` / `start.cmd`”的步骤现在统一等价于改 `.env`：
> `RELAY_URL`、`PUBLIC_PAIR_URL`、`DSH2PHONE_ALLOW_INVALID_CERT`（隧道侧 `TUNNEL_INSECURE` 仍可覆盖）。

> **2026-10-27 23:00 状态更新**：域名在用户访问侧已不可用，先执行 [ip-emergency-plan.md](ip-emergency-plan.md) 的 P0；本文作为背景、方案对比与 P1 详细依据。

## 0. 结论摘要

**功能上完全可行，链路已经在 IP 上实测跑通；但“直接把域名换成 IP、继续用现有域名证书”只能算应急，不建议长期使用。**

- **可行**：IP 请求能到达 nginx，relay 门禁、隧道、DSH 页面全部正常。实测 `https://<SERVER_IP>/dsh/` 在带合法设备/DSH cookie 时返回 **200、43,178 字节、含 `__DSH_BOOT__`**。
- **唯一的硬门槛是证书**：现有 Let's Encrypt 证书只含 `<PUBLIC_DOMAIN>` / `www.<PUBLIC_DOMAIN>`，不含 IP；浏览器访问 `https://<SERVER_IP>/` 必然报证书不匹配。
- **好消息**：Let's Encrypt 从 2026-01-15 起正式签发 IP 地址证书（免费、约 6 天短周期），Certbot ≥ 5.4 支持 `--ip-address` + `--webroot`。服务器 snap 可用，HTTP-01 验证路径已模拟通过。
- **推荐做法**：保留域名为默认入口，新增一张 IP 证书 + 一个 443 默认 server 作为**双栈备用**；需要绕 SNI 时只把手机二维码入口切到 IP，PC 侧继续走域名。不要为了 IP 去关闭证书校验。
- **裸切（IP + 现有证书 + 关闭校验）的代价**：手机每次新会话/重启浏览器可能都要跳过证书警告；部分国产浏览器/内置 WebView 可能直接拒绝；PC 隧道必须关校验，等于在正在发生网络干扰的环境里主动放弃防 MITM，风险高于收益。

## 1. 评估范围

本文只覆盖 dsh2phone 的公网链路：

```
手机浏览器 ──HTTPS──► nginx:443 ──► dsh-relay:3200/:3201 ──WSS──► 本机 tunnel ──► DSH :43120
```

不包含：

- `<PUBLIC_DOMAIN>` 主站、`backend`、`mongodb`、邮件等其它服务（如果整站改 IP，还需单独检查它们的绝对 URL、CORS、OAuth 回调）。
- DSH Desktop 的局域网 HTTPS 入口 `:2622`（与本链路无关）。
- 域名注册/备案/合规问题。

## 2. 实测证据（2026-10-27）

### 2.1 数据面：IP 已经能跑通

| 检查 | 结果 |
|---|---|
| `https://<SERVER_IP>/dsh-pair`（无 SNI） | **200**，返回“等待配对/需要先配对”页 |
| `https://<SERVER_IP>/dsh/`（无 cookie） | **403 未知设备**（relay 门禁正常生效） |
| 同上 + 已配对设备 cookie + 本机铸造的 DSH cookie | **200，43,178 bytes，含 `__DSH_BOOT__`**，DSH 前端 HTML 正常 |
| `http://<SERVER_IP>/dsh-pair` | **301** → `https://<SERVER_IP>/dsh-pair`（路径/查询串保留） |
| `https://<PUBLIC_DOMAIN>/dsh-pair`（对照） | **200**，与 IP 返回同一张页面（2,089 bytes） |
| 服务器 `healthz` | `tunnel:online` |

补充：本次实测时**域名入口也正常**（`/dsh-pair` 200），10-25 的 SNI reset 没有复现。因此下面的 IP 方案是“为可能复发的过滤做准备”，不是当前故障的修复。

结论：**IP 不是“理论上可以”，而是当前配置下已经通**。`dsh.location` 里固定传 `Host: 127.0.0.1:43120`、剥离 `Origin`，所以 DSH 的信任栅栏与公网 Host 无关；IP 只影响浏览器这一跳。

### 2.2 证书：当前唯一不匹配的地方

无 SNI 连接 `<SERVER_IP>:443` 时，nginx 返回默认 server 的域名证书：

| 字段 | 值 |
|---|---|
| Subject / CN | `<PUBLIC_DOMAIN>` |
| SAN | `DNS:www.<PUBLIC_DOMAIN>, DNS:<PUBLIC_DOMAIN>`（**没有 IP**） |
| Issuer | Let's Encrypt |
| 到期 | 2026-12-07 23:38:17 UTC（当前有效） |
| Node 校验结果 | `ERR_TLS_CERT_ALTNAME_INVALID`（IP 不在证书 SAN 中） |

浏览器访问 IP 会进入证书 interstitial（Chrome/Edge 的“您的连接不是私密连接”，Safari 的“此连接非私人连接”）。**这不是服务器错误，而是证书主体不匹配。**

### 2.3 控制面：IP 下必须处理证书校验

| 检查 | 结果 |
|---|---|
| `wss://<SERVER_IP>/dsh-tunnel` + 正常校验 | 失败：`Hostname/IP does not match certificate's altnames: IP: <SERVER_IP> is not in the cert's list` |
| 同上 + `rejectUnauthorized:false`（admin 模式） | 成功 `hello.ok`，`devices.list` 返回 2 台设备 |
| `wss://<PUBLIC_DOMAIN>/dsh-tunnel` | 正常（隧道日志 `relay online`） |

这说明：**如果 PC 侧也改走 IP，插件/隧道必须显式 `allowInvalidCert` / `TUNNEL_INSECURE`（在没有 IP 证书时）；有有效 IP 证书则不需要。**

### 2.4 服务器现状

| 项 | 现状 |
|---|---|
| nginx | 1.21.5；443 只有**一个** server 块（`server_name <PUBLIC_DOMAIN> www.<PUBLIC_DOMAIN>`），因此 IP 请求走它；无 HSTS |
| 证书续期 | apt 的 `certbot 2.9.0` + `certbot.timer`；续期用 webroot `/usr/local/compose/www` |
| certbot 能力 | 2.9.0 **没有** `--ip-address` / `--preferred-profile`；需升级到 ≥ 5.4 |
| snap | snapd 2.76 可用；当前未安装 certbot snap |
| ACME 连通性 | 服务器访问 `https://acme-v02.api.letsencrypt.org/directory` → **200** |
| HTTP-01 路径 | 模拟“80 → 301 → HTTPS（忽略证书）”：challenge 文件返回 **200 且内容匹配** |
| 公网 IP | <SERVER_IP>；网卡是 172.19.133.87（阿里云 NAT/EIP），只要不释放/更换就稳定 |
| 设备注册表 | 当前 2 台（其中 1 台是 Android 10 Chrome，可能是测试遗留）；切 origin 后旧 cookie 全部失效 |

### 2.5 DSH 前端是否依赖 origin

检查了 DSH 安装目录 `@deepseek-ai/dsh-web-frontend/dist`：

- `index.html`、资源、`manifest.webmanifest` 全部用**相对路径**（`./assets/...`、`start_url: "./"`、`scope: "./"`）。
- 未发现有 service worker 注册；`display: fullscreen`，具备 PWA 条件。
- 未发现 `location.origin` / `location.host` 之类把公网 origin 写死的代码。

因此 DSH 前端本身不关心公网 Host 是域名还是 IP；PATH 前缀 `/dsh/` 不变即可。

## 3. 改成 IP 后，哪些要改、哪些会断

### 3.1 不需要改

- `relay/src/relay.mjs`：设备门禁、配对、数据面、控制面协议都与 Host/origin 无关。
- `tunnel/src/tunnel.mjs` 的转发逻辑（只改 `RELAY_URL` 这类配置）。
- DSH 侧任何配置（本机当前没有 `trustedHosts` / `publicUrl` 覆盖；`networkExposure` 也不用动）。如果以后给 DSH 配了 `publicUrl`，需要按新 origin 复核。
- `deploy/nginx/dsh.location` 的三个 location（`/dsh-tunnel`、`/dsh-pair`、`/dsh/`）及其 `Host 127.0.0.1:43120`、`Origin ""`。
- 安全模型：token 不出公网、设备白名单、配对码、cookie HMAC、panic/deny。

### 3.2 必须改

| 位置 | 改动 |
|---|---|
| nginx | 新增 443 `default_server`（IP 证书）+ 只 include `dsh.location`；或至少让 IP 命中 IP 证书 server 块 |
| 证书 | 为 `<SERVER_IP>` 申请 IP 证书；或接受证书警告（应急） |
| `.env` | `PUBLIC_PAIR_URL` → `https://<SERVER_IP>/dsh-pair`；如 PC 也走 IP，再改 `RELAY_URL` |
| `cordis.patch.yml` | 无需改（config 为空，全部来自 `.env`） |
| 文档/测试 | `tools/*` 已改为读 `.env`（`PUBLIC_PAIR_URL` / `RELAY_URL` / `DSH_AUTHORITY`） |
| 手机 | **重新配对**；旧主屏幕图标/书签重建 |

### 3.3 会失效/会丢

- **旧 `dshdev` 设备 cookie、旧 DSH cookie**：cookie 是 host-scoped，域名下的 cookie 不会发给 IP。必须重新配对，不能“迁移”。
- **旧 origin 的 PWA/主屏幕图标/书签**：指向域名，切 IP 后需要重建。
- **旧 origin 的 localStorage / IndexedDB**：新 origin 是空的；DSH 的会话/项目数据在 PC 端，不受影响，但界面偏好可能重置。
- **设备注册表旧条目**：会变成“孤儿”（仍 allow，但再也不会被使用），建议 remove 清理。
- **旧域名入口**：可以继续保留（双栈），不冲突。

### 3.4 千万不要改

- `authority: 127.0.0.1:43120`：这是 **DSH 看到的 Host**，不是公网地址。改成 IP 会让铸造的 DSH cookie 与 DSH 校验的 authority 不一致，直接登录失败。
- nginx 的 `proxy_set_header Host 127.0.0.1:43120` 和 `Origin ""`：同上，是 DSH 信任栅栏的关键。
- `PUBLIC_PREFIX`（`/dsh`）：路径前缀与 origin 无关，不需要动。
- 不要为了“让证书通过”去设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`（全局关闭校验），也不要长期 `TUNNEL_INSECURE=1`。

## 4. 证书是唯一的硬门槛

### 4.1 方案 A（推荐长期）：Let's Encrypt IP 证书

Let's Encrypt 已从 2026-01-15 起正式签发 IP 地址证书，**必须使用 `shortlived` profile，有效期约 160 小时（6 天出头）**；HTTP-01 和 TLS-ALPN-01 可用于 IP，DNS-01 不行。参考：

- [6-day and IP Address Certificates are Generally Available](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Six-Day and IP Address Certificates Available in Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)
- [Challenge Types](https://letsencrypt.org/docs/challenge-types/)

Certbot 要求：

- `--preferred-profile` 从 4.0 起支持；
- `--ip-address` 从 5.3 起支持；
- `--webroot` 的 IP 支持从 **5.4** 起。

服务器现状是 2.9.0，**必须先升级**。签发命令（以 root 执行，先 staging）：

```bash
# 1) 升级 certbot（推荐 snap classic；venv 兜底见第 7 节 Phase 1）
systemctl disable --now certbot.timer          # 停掉 apt 的旧 timer
apt-get remove -y certbot
snap install certbot --classic
ln -sf /snap/bin/certbot /usr/local/bin/certbot
certbot --version                               # 期望 >= 5.4

# 2) staging 试签（不产生受信任证书，只验证验证链路）
certbot certonly --staging \
  --preferred-profile shortlived \
  --webroot -w /usr/local/compose/www \
  --ip-address <SERVER_IP> \
  --cert-name <SERVER_IP>-staging \
  --deploy-hook 'docker exec nginx nginx -s reload'

# 3) staging 成功后删除，再签正式证书
certbot delete --cert-name <SERVER_IP>-staging
certbot certonly \
  --preferred-profile shortlived \
  --webroot -w /usr/local/compose/www \
  --ip-address <SERVER_IP> \
  --cert-name <SERVER_IP> \
  --deploy-hook 'docker exec nginx nginx -s reload'
```

为什么 HTTP-01 能过：当前 80 端口对任何 Host 都是 `301 → https://$host$request_uri`；Let's Encrypt 的 HTTP-01 **会跟随跳转，且不校验证书**（官方文档明确说明），所以 301 到 `https://<SERVER_IP>/...` 之后即使证书是域名的，也能取到 `www/.well-known/acme-challenge/<token>`。本次已用临时文件模拟：`301 → 200`，内容完全匹配。

续期要点：

- Certbot 4.0+ 的续期阈值是“剩余寿命 < 1/3；寿命 ≤ 10 天时为 1/2”，6 天证书大约每 3 天续一次。
- Let's Encrypt 的 ARI 续期**免限流**；即使不用 ARI，约 2–3 次/周也低于“同一组标识符 5 张/7 天”的限制。
- **必须确认 `/etc/letsencrypt/renewal/<SERVER_IP>.conf` 里保留了 `preferred_profile = shortlived`**；否则续期可能按默认 profile 申请，被 CA 拒绝。用 `certbot renew --cert-name <SERVER_IP> --dry-run` 验证（见 [Rate Limits](https://letsencrypt.org/docs/rate-limits/)、[Certbot User Guide](https://eff-certbot.readthedocs.io/en/stable/using.html)）。
- 6 天证书意味着**续期失败只有 6 天窗口**；必须配 `--deploy-hook` 或 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`，并加一个到期监控（见第 10 节）。

### 4.2 方案 B（仅应急）：IP + 现有域名证书

不改服务器、不签新证书；只把客户端 URL 改成 IP，接受证书警告：

- 手机：`https://<SERVER_IP>/dsh-pair` 会先出现证书警告；Chrome 可“高级 → 继续前往”，Safari 可“显示详细信息 → 访问此网站”，部分国产浏览器/WebView 可能不提供继续入口（你的手机当前 UA 是 Quark 内核，需实机确认）。
- PC 侧若也走 IP：插件 `allowInvalidCert: true`，隧道 `TUNNEL_INSECURE=1`；否则只有手机这一跳走 IP、PC 继续走域名（此时 PC 侧不需要关校验）。
- 代价：
  - 每次新会话/重启浏览器可能再次警告；
  - PWA 安装/主屏幕体验受限；
  - 用户被训练成“忽略证书警告”，而这条链路拥有 DSH 的完整操作权限（会话、文件、审批/工具调用等）；
  - PC 侧关校验会暴露 `DSH_TUNNEL_KEY` 和全部流量给主动 MITM——**在正在被网络干扰的环境里尤其危险**。

**结论：方案 B 只适合“现在就要用、证书 10 分钟内签不出来”的应急，不适合作为长期状态。**

### 4.3 方案 C：商业 IP 证书

部分商业 CA 签发含公网 IP SAN 的证书（通常 1 年、需要企业验证、付费）。适合“不想维护 6 天证书”的场景，但成本和人工验证高于 Let's Encrypt。若选这条，nginx 配置与方案 A 相同，只是证书路径/续期方式不同。

### 4.4 方案 D：自签/私有 CA

把自签 CA 装到手机上（iOS 需装描述文件并手动信任；Android 需装用户 CA）。可行但脆弱：换手机/系统升级/浏览器不信任用户 CA 都会失效；CA 私钥泄露风险也由自己承担。**不推荐**，除非是受控的单一设备实验。

### 4.5 备选：换一个“干净”的域名

如果 10-25 的过滤只针对 `<PUBLIC_DOMAIN>` 这个 SNI（当时的证据：同 IP 换 `example.com` SNI 正常），那么换一个未被针对的域名，可以保留 90 天证书和现有体验，成本可能低于 IP 方案。但需要新域名、解析，以及（大陆服务器）备案/接入问题；如果过滤是按 IP 或按客户端指纹，而不是按名字，换域名也无效。

## 5. 方案对比

| 方案 | 手机体验 | 安全 | 运维成本 | 抗 SNI 过滤 | 适用场景 |
|---|---|---|---|---|---|
| 保持域名 | 好（有锁） | 好 | 低（90 天自动续） | 差（若被针对） | 默认 |
| IP + 现有域名证书 | 差（警告/可能被拒） | 差（关校验/MITM） | 低（无新证书） | 较好（不发 SNI） | 仅应急 |
| IP + Let's Encrypt IP 证书 | 好（有锁） | 好 | 中（6 天续期+监控） | 较好 | 推荐长期 |
| IP + 商业 IP 证书 | 好 | 好 | 中（年付+人工验证） | 较好 | 不想折腾 6 天证书 |
| 换干净域名 | 好 | 好 | 低（90 天） | 取决于过滤维度 | 过滤只针对原名 |

功能上三种“IP”证书方案都能通；差别在证书、体验和运维。

## 6. 推荐落地方式：域名主 + IP 备（双栈）

```
手机 ──HTTPS(IP, 有效 IP 证书)──► nginx:443 default_server (server-ip.conf)
                                      └─ /dsh-tunnel /dsh-pair /dsh/ → dsh-relay

PC 插件/隧道 ──WSS(域名, 现有 90 天证书)──► nginx:443 (server.conf) → dsh-relay
```

为什么推荐这个形态：

1. **改动最小**：PC 控制面继续用域名和现有证书，不需要 `TUNNEL_INSECURE`，也不需要 `allowInvalidCert`；只有手机这一跳换成 IP。
2. **可回滚**：域名 server 块完全不动；把 `publicKeyUrl` 改回域名、重装插件即可回滚（手机需再配一次）。
3. **风险隔离**：IP 证书续期失败时，域名入口仍然可用（在未被过滤时）；不会因为一张 6 天证书把整个系统锁死。
4. **只暴露 dsh2phone**：IP server 块只 include `dsh.location`，其它路径 404，不把主站/后端顺带暴露到 IP。

最小切换（只改手机入口）：

```dotenv
# .env — 只改手机入口，PC 控制面保持域名
PUBLIC_PAIR_URL=https://<SERVER_IP>/dsh-pair
# RELAY_URL=wss://<PUBLIC_DOMAIN>/dsh-tunnel   # 保持不变

# PC 侧也要走 IP 时（无有效 IP 证书阶段）
# RELAY_URL=wss://<SERVER_IP>/dsh-tunnel
# DSH2PHONE_ALLOW_INVALID_CERT=1
```

有有效 IP 证书时**不要**设 `DSH2PHONE_ALLOW_INVALID_CERT=1`，也**不要**设 `TUNNEL_INSECURE`。改完跑 `node tools/check-env.mjs`，再重装插件让 host 重新读取。

## 7. 实施 runbook（确认后照做）

> 以下命令以 root 在 `<SERVER_IP>` 执行；改配置前先备份服务器 `/usr/local/compose/conf/nginx`，以及本机的插件/隧道配置文件。

### Phase 0：前置检查

- [ ] 确认 80/443 从公网可达（本次已验证）。
- [ ] 确认 IP 是固定 EIP/公网 IP（阿里云控制台看；若会变，先解决固定 IP 问题）。
- [ ] `nginx -T` 确认没有其它 `default_server`。
- [ ] 备份：`cp -a /usr/local/compose/conf/nginx /usr/local/compose/conf/nginx.bak.$(date +%F)`。

### Phase 1：升级 certbot

按 4.1 的 1) 执行。若 snap 不可用或 hook 受 confinement 限制，用 venv 兜底：

```bash
systemctl disable --now certbot.timer
apt-get remove -y certbot
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install -U pip certbot
ln -sf /opt/certbot/bin/certbot /usr/local/bin/certbot
certbot --version
```

两种方式任选其一，**不要同时保留两个 certbot 在跑 renew**。venv 方式没有 snap 自带的续期 timer，需要自己加 cron/systemd timer（例如每天两次 `certbot renew`），否则 6 天证书会静默过期。

### Phase 2：签 IP 证书

按 4.1 的 2)/3) 执行 staging → production。检查：

```bash
certbot certificates
ls -l /etc/letsencrypt/live/<SERVER_IP>/
grep -E 'preferred_profile|webroot|deploy|ip_address' /etc/letsencrypt/renewal/<SERVER_IP>.conf
certbot renew --cert-name <SERVER_IP> --dry-run       # IP 证书
certbot renew --cert-name <PUBLIC_DOMAIN> --dry-run        # 确认升级后域名证书仍能续
```

### Phase 3：加 nginx IP server 块

把 [server-ip.conf.example](../deploy/nginx/server-ip.conf.example) 的内容上传到服务器，写成 `conf.d/server-ip.conf`（注意示例里的证书路径/cert-name 要与实际一致），然后：

```bash
# 内容来自仓库 deploy/nginx/server-ip.conf.example
install -m 0644 /root/server-ip.conf /usr/local/compose/conf/nginx/conf.d/server-ip.conf
docker exec nginx nginx -t
docker exec nginx nginx -s reload
```

注意：

- `server-ip.conf` 只 include `dsh.location`，并 `location / { return 404; }`；不要把 `chat.location` / `xn.location` 带进去。
- `default_server` 只应出现在 IP 块；`server.conf` 保持 `listen 443 ssl;`。
- 证书路径必须与签发的 cert-name 一致。

### Phase 4：客户端与手机

1. 改 `.env` 的 `PUBLIC_PAIR_URL`（最小切换只改这一行；`cordis.patch.yml` 不用动）。
2. 跑 `node tools/check-env.mjs` 自检。
3. 重装插件并切换一次启用状态，让运行中的 Service 重新读配置：
   `plugin_manager install_bundle target=<REPO_DIR>\dsh2phone-dsh-plugin`
   （或在 GUI 中禁用/启用；仅改文件不重装，旧 Service 仍用旧配置。）
4. 如 PC 侧也切 IP：改 `.env` 的 `RELAY_URL`（必要时 `DSH2PHONE_ALLOW_INVALID_CERT=1`），**同时改 Startup 文件夹里的 `dsh2phone-tunnel.vbs` 副本**（它自带 `RELAY_URL` 会覆盖 `.env`）；按命令行过滤、停掉正在运行的 `wscript.exe` supervisor 后重新启动（不要误杀其它 wscript），否则它仍用旧环境变量。
5. 手机重新配对：插件 →“配对手机”→ 扫码 → DSH 内确认 → 入口页 →“进入 DSH” → 添加到主屏幕。
6. 清理旧设备记录（插件设备页或 `devices.cmd remove <id>`），删除旧域名主屏幕图标/书签。

### Phase 5：验证与监控

见第 8、10 节。

## 8. 验证清单

- [ ] `echo | openssl s_client -connect <SERVER_IP>:443 2>/dev/null | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'` 显示 SAN 含 `IP Address:<SERVER_IP>`。
- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' https://<SERVER_IP>/dsh-pair` → 200，无证书警告。
- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' https://<SERVER_IP>/dsh/` → 403（未配对设备）。
- [ ] 配对后手机打开 `/dsh/`：地址栏有锁、应用渲染、会话列表出现、消息可发、审批弹窗正常、WS 断线能重连。
- [ ] `https://<PUBLIC_DOMAIN>/dsh-pair` 仍 200（域名入口未被破坏）。
- [ ] `docker exec dsh-relay wget -qO- http://127.0.0.1:3201/healthz` → `tunnel:online`。
- [ ] `certbot renew --cert-name <SERVER_IP> --dry-run` 成功。
- [ ] `systemctl list-timers | grep -i certbot` 只有一个续期 timer（snap 或 apt，二选一）。
- [ ] 手机重开主屏幕图标仍能进入（origin 已固定为 IP）。

## 9. 回滚

1. 把 `.env` 的 `PUBLIC_PAIR_URL`（以及可选的 `RELAY_URL`）改回域名。
2. 重装插件 / 切换启用状态。
3. 手机重新扫域名二维码配对（origin 又变一次，无法复用 IP cookie）。
4. 域名 `server.conf` 始终未动，`server-ip.conf` 可以保留（双栈）或改名为 `.bak` 后 `nginx -s reload`。
5. 若 IP 证书续期失败：不需要紧急回滚，手机仍可暂时用域名入口（在未被过滤时）；修复证书后再切回 IP。

## 10. 风险与运维

| 风险 | 影响 | 缓解 |
|---|---|---|
| 阿里云公网 IP 变更/释放 | 证书、二维码、客户端配置全失效，手机需重配对 | 用 EIP 并记录变更流程；保留域名作为主入口 |
| 6 天证书续期失败 | 最长 6 天后手机 HTTPS 全挂 | 确认 `preferred_profile`；`certbot renew --dry-run`；加到期监控；保留域名回退 |
| 过滤实际按 IP/指纹而非 SNI | IP 也无效 | 先在手机上实测；若仍被 reset，考虑 CDN/域名前置/换网络，而不是继续换 URL |
| 无证书裸切 | 每次警告；部分浏览器直接拒绝；MITM 风险 | 不做长期方案；应急后尽快签 IP 证书 |
| PWA/主屏幕/书签 origin 变化 | 旧图标失效、localStorage 重置 | 重新添加；文档告知；会话数据在 PC 端不受影响 |
| nginx 配错 default_server | 域名或 IP 命中错误证书 | `nginx -t`；确认只有一个 default_server；先 staging |
| IP 入口误暴露主站 | 主站/其它 location 可通过 IP 访问 | 只 include `dsh.location` + `location / { return 404; }` |
| 证书续期 hook 在 snap 中被限制 | reload 不执行，nginx 继续用旧证书（直到过期） | 用 classic snap 或 venv certbot；单独 systemd timer 执行 reload |

**监控建议**：每天检查一次 IP 证书剩余天数（`echo | openssl s_client -connect <SERVER_IP>:443 2>/dev/null | openssl x509 -noout -checkend 172800`），失败时至少发一个通知；6 天证书的容错窗口很短，不能只依赖“certbot 会自己续”。

## 11. 最终建议

1. **现在不要裸切。** 当前域名链路是通的；没有 IP 证书的切换只会把“偶发 SNI 重置”换成“每次证书警告 + 关校验”。
2. **如果 10-25 的过滤复发、且确认是 SNI 维度**：按方案 A 签 IP 证书，用双栈；**只把手机入口 `publicKeyUrl` 切到 IP**，PC 侧留域名。这是收益/风险最好的组合。
3. **如果确实要全链路 IP**：同样先签 IP 证书；然后改 `relayUrl`、隧道 URL、CLI URL；有有效证书时不要关闭校验。
4. **如果不愿意维护 6 天证书**：保持域名；或买 1 年期商业 IP 证书；或换一个未被针对的域名（需解决备案/解析）。
5. **无论选哪种**：`authority` 保持 `127.0.0.1:43120`，nginx 的 `Host`/`Origin` 不要动，token 不要出公网，设备白名单/panic 机制继续保留。

## 附录 A：关键实测输出

```text
# 域名 vs IP 的 /dsh-pair（本机 Node，2026-10-27）
{"host":"<PUBLIC_DOMAIN>","status":200,"len":2089}
{"host":"<SERVER_IP>","status":200,"len":2089}

# IP 的完整 DSH 页面（带已配对设备 cookie + 铸造的 DSH cookie）
{"status":200,"len":43178,"boot":true,"ctype":"text/html; charset=utf-8"}

# 无 SNI 的证书
{"servername":"(none)","ok":true,"subject":"<PUBLIC_DOMAIN>",
 "san":"DNS:www.<PUBLIC_DOMAIN>, DNS:<PUBLIC_DOMAIN>",
 "authError":"ERR_TLS_CERT_ALTNAME_INVALID"}

# 控制面
{"url":"wss://<SERVER_IP>/dsh-tunnel","insecure":false,"ok":false,
 "error":"Hostname/IP does not match certificate's altnames: IP: <SERVER_IP> is not in the cert's list"}
{"url":"wss://<SERVER_IP>/dsh-tunnel","insecure":true,"ok":true,"mode":"admin","devices":2}
```

## 附录 B：相关文件

- nginx 配置示例：[deploy/nginx/server-ip.conf.example](../deploy/nginx/server-ip.conf.example)
- 现有域名入口：[deploy/nginx/dsh.location](../deploy/nginx/dsh.location)
- 插件配置模板：[dsh2phone-dsh-plugin/cordis.patch.example.yml](../dsh2phone-dsh-plugin/cordis.patch.example.yml)（运行 `node tools/render-plugin-patch.mjs` 生成机器相关的 `cordis.patch.yml`）
- 配置模板：[.env.example](../.env.example)（真实值只在本机 `.env`）
- 隧道启动：[tunnel/start.cmd](../tunnel/start.cmd)、自启模板 [tunnel/autostart.vbs.example](../tunnel/autostart.vbs.example)
- 交接文档：[docs/HANDOFF.md](HANDOFF.md)
