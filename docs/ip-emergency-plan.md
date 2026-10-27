# dsh2phone 域名失效 → IP 应急切换预案

> 触发：**域名在访问侧已不可用，只能通过 IP 访问**（2026-10-27 23:00）
> 目标：**先 5–10 分钟恢复手机访问（P0），再 30–60 分钟消除证书警告/关校验（P1）**
> 背景与证书细节：[ip-feasibility.md](ip-feasibility.md)
> 原则：P0 只改客户端 URL，**不改服务器、不签证书、不关校验**（除非 PC 侧也走不通）；P1 再补 IP 证书。
>
> ⚠️ 配置已集中到 `.env`（模板 `.env.example`）。下文凡是要“改 URL / 关校验”的地方，等价于改 `.env` 里的
> `RELAY_URL`、`PUBLIC_PAIR_URL`、`DSH2PHONE_ALLOW_INVALID_CERT`（隧道侧的 `TUNNEL_INSECURE` 仍可单独覆盖）。
> `cordis.patch.yml` 与 `*.cmd` 里已不再保存域名、IP 和密钥；改完先跑 `node tools/check-env.mjs` 自检。

## 立即执行（TL;DR）

1. 手机 **Chrome** 打开 `https://<SERVER_IP>/dsh-pair`，确认能跳过证书警告；若显示 **503** → 走 P0-B。
2. 电脑 DSH 点一次 **“配对手机”**，能出二维码 → P0-A 可行；报连接失败 → 走 P0-B。
3. 备份 `.env` 与（生成的）`cordis.patch.yml`。
4. `.env` 的 `PUBLIC_PAIR_URL` → `https://<SERVER_IP>/dsh-pair`（`RELAY_URL` 先不动）。
5. 重装插件 + 禁用/启用一次。
6. 手机 Chrome 扫新二维码 → 继续访问 → 电脑确认 → 入口页“进入 DSH” → 添加到主屏幕。
7. 验证；**不要清站点数据**；**不要盲目删设备**（UA 去重可能复用同一条）。
8. 然后做 P1（IP 证书）；origin 不变，**无需二次配对**。

## 0. 当前判定（23:02 实测）

| 检查 | 结果 | 含义 |
|---|---|---|
| `<PUBLIC_DOMAIN>` DNS | `<SERVER_IP>`（TTL 60） | 从本机看 DNS 正常 |
| 域名 `/dsh-pair`（本机） | **200** | 服务器/域名链路从本机仍通 |
| IP `/dsh-pair` | **200** | IP 入口可用 |
| IP `/dsh/`（无 cookie） | **403 未知设备** | relay 门禁正常；手机还没有 IP 侧 cookie |
| `tunnel.log` | 23:02:25 重连，`relay online` | PC→relay 控制面目前在线 |
| 服务器 `healthz` | `tunnel:online` | relay 有可用隧道 |

**判断**：服务器、DNS、隧道目前都没死；失效在**手机访问路径**（DNS/SNI/运营商）。因此先走 **P0-A**（只切手机入口）。如果你确认 **PC 侧域名也不可用或域名不再续费**，直接走 **P0-B**（全量 IP）。

## 1. 方案分级

| 级别 | 做什么 | 耗时 | 代价 | 何时用 |
|---|---|---|---|---|
| **P0-A** | 只把手机二维码入口改成 IP，PC 控制面留域名 | 5–10 min | 手机每次新会话可能要点“继续访问” | 默认先做 |
| **P0-B** | 手机 + PC 全部改 IP，临时关校验 | +5 min | 临时放弃 MITM 防护 | PC 侧域名也不可用/隧道离线 |
| **P1** | 签 IP 证书 + nginx IP server，关掉临时关校验 | 30–60 min | 6 天证书运维 | P0 之后 |
| **P2** | 双栈/监控/文档固化 | 持续 | — | 稳定后 |

**关键**：P0 和 P1 使用**同一个 IP origin**（`https://<SERVER_IP>`）。P1 只是把证书换成有效的，**不需要二次配对**；手机 cookie 按 host 存，origin 不变就继续有效。

## 2. 决策树

```
手机只能走 IP？
├─ relay 在线（healthz = tunnel:online，tunnel.log 最近有 relay online）
│    └─ P0-A：只改 publicKeyUrl → IP，PC 侧留域名
│         ├─ 手机能跳过证书警告 → 配对成功 → 进入 P1
│         └─ 手机浏览器拒绝跳过 → 换 Chrome；仍不行 → 先做 P1
└─ relay 离线 / PC 侧域名也失败
     └─ P0-B：publicKeyUrl + relayUrl + 隧道全部改 IP，临时 allowInvalidCert/TUNNEL_INSECURE
          └─ 配对成功 → 进入 P1
```

## 3. P0-A：只切手机入口（推荐，5–10 分钟）

### 3.1 前置确认

- [ ] 手机浏览器能打开 `https://<SERVER_IP>/dsh-pair`（证书警告后能继续）；如果显示 **503“电脑端连接中”**，说明隧道不在线，直接走 P0-B。
- [ ] PC 上 `tunnel.log` 最近有 `relay online`；服务器 `healthz` 为 `tunnel:online`。
- [ ] **关键**：在 DSH 里点一次“配对手机”，能正常生成二维码。这只证明 PC 的**新建 admin WSS** 还能走域名；如果这里报连接失败，即使 `healthz` 显示 online（老隧道还活着），也要直接走 P0-B。
- [ ] 手机推荐用 **Chrome**，不要用 Quark/内置 WebView（证书警告可能没有“继续访问”入口）。

### 3.2 备份

```powershell
$ts = Get-Date -Format yyyyMMdd-HHmm
Copy-Item .\.env ".\.env.bak-$ts"
Copy-Item .\dsh2phone-dsh-plugin\cordis.patch.yml ".\dsh2phone-dsh-plugin\cordis.patch.yml.bak-$ts"
```

### 3.3 改 `.env` 一行

```dotenv
# 只把手机入口换成 IP；PC 控制面继续走域名
PUBLIC_PAIR_URL=https://<SERVER_IP>/dsh-pair
# RELAY_URL 保持不变
```

改完先自检，再让插件重新读配置（`host.js` 是进程内模块）：

```text
node tools/check-env.mjs
plugin_manager install_bundle target=<REPO_DIR>\dsh2phone-dsh-plugin
```

装完后在 DSH 里把 `dsh2phone` 插件**禁用再启用**（或重启 Desktop）。只改文件不重装，运行中的 Service 可能仍用旧 `publicKeyUrl`，二维码还是域名。

### 3.5 手机重新配对

1. 电脑打开 DSH → 左下角账号菜单 → **“配对手机”**，二维码现在应是 `https://<SERVER_IP>/dsh-pair?code=...`。
2. 手机用 **Chrome** 扫二维码。
3. 出现证书警告：Chrome 点 **高级 → 继续前往 <SERVER_IP>（不安全）**；Safari 点 **显示详细信息 → 访问此网站**。
4. 手机会停在加载中（请求被 relay 挂起，等待电脑确认）；电脑 DSH 会弹出确认框（设备名/IP），点允许。若手机直接看到 403“配对码无效或已过期”，重新生成二维码。
5. 手机看到“配对成功 / 进入 DSH”入口页 → 点 **进入 DSH** → 浏览器菜单 **添加到主屏幕**。
6. 如果二维码被 Quark 打开且无法继续：在电脑上复制二维码里的完整 URL，发到手机 Chrome 打开；配对码 5 分钟有效，过期就重新生成。
7. 设备页可能**不会新增一条**：relay 现在会按 UA 复用已有设备（见 HANDOFF“配对去重”）。只要手机能进入 IP 的 DSH 就说明成功，不要因为设备数没变而重复配对。反过来，如果你从 Quark 换到 Chrome，UA 变了，通常会新增一条；旧 Quark 条目确认后再删。

### 3.6 验证

- [ ] 手机 `https://<SERVER_IP>/dsh/` 能渲染 DSH、会话列表出现、能发消息、审批弹窗正常。
- [ ] 电脑插件设备页里当前手机的 `lastSeen` 已更新；可能仍是原来那一条（UA 去重复用），不一定是新增。
- [ ] `tunnel.log` 仍有 `relay online`；服务器 `healthz` 为 `tunnel:online`。
- [ ] 手机重开主屏幕图标仍能进入（IP origin）。

### 3.7 清理

- **不要盲目 remove “旧域名设备”**：relay 可能已经按 UA 把 IP 配对复用到同一条设备记录；remove 会把当前手机一起吊销。先看设备页的名称/UA/lastSeen，确认哪条是当前手机；最稳妥是暂时不清理，稳定后再处理。
- 旧域名主屏幕图标/书签可以删除。
- **不要清除浏览器站点数据**（会把刚配对的 IP cookie 一起删掉）。

## 4. P0-B：全量 IP（仅当 PC→relay 也不可用，+5 分钟）

### 4.1 触发条件

- 服务器 `healthz` 不是 `tunnel:online`；或
- `tunnel.log` 反复 `ws error` / `ENOTFOUND` / `ECONNRESET` / `404`，说明 PC 的域名路径也不可用；或
- 你确认域名已不再续费/不再恢复。

### 4.2 备份

```powershell
$ts = Get-Date -Format yyyyMMdd-HHmm
Copy-Item .\.env ".\.env.bak-$ts"
Copy-Item .\dsh2phone-dsh-plugin\cordis.patch.yml ".\dsh2phone-dsh-plugin\cordis.patch.yml.bak-$ts"
Copy-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\dsh2phone-tunnel.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\dsh2phone-tunnel.vbs.bak-$ts"
```

### 4.3 改配置

`.env`（一份文件覆盖插件 + 隧道；`DSH_TUNNEL_KEY` 原样保留，不要贴进聊天/文档）：

```dotenv
RELAY_URL=wss://<SERVER_IP>/dsh-tunnel
PUBLIC_PAIR_URL=https://<SERVER_IP>/dsh-pair
DSH2PHONE_ALLOW_INVALID_CERT=1
```

已安装的 Startup 副本 `dsh2phone-tunnel.vbs` 自带环境变量，**会覆盖 `.env`**，所以副本里也要改（或直接删掉这些 `Environment("PROCESS")` 行，让它只读 `.env`）：

```vbs
sh.Environment("PROCESS")("RELAY_URL") = "wss://<SERVER_IP>/dsh-tunnel"
sh.Environment("PROCESS")("TUNNEL_INSECURE") = "1"
```

### 4.4 重启 supervisor（关键）

VBS supervisor 在启动时读取环境变量；只杀 `node.exe` 不够，它会被旧 env 的 supervisor 重新拉起。

```powershell
# 结束运行 dsh2phone-tunnel.vbs 的 wscript（按命令行过滤，避免误杀其它脚本）
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
  Where-Object { $_.CommandLine -like '*dsh2phone-tunnel.vbs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 重新启动 Startup 里的副本
Start-Process wscript.exe -ArgumentList '"<USER_HOME>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\dsh2phone-tunnel.vbs"'
```

如果 CIM 被策略拒绝：任务管理器 → 详细信息 → 找到命令行含 `dsh2phone-tunnel.vbs` 的 `wscript.exe` → 结束任务 → 双击 Startup 里的 VBS。

验证：

```powershell
Get-Content .\tunnel.log -Tail 10
# 期望：connecting wss://<SERVER_IP>/dsh-tunnel ... relay online
```

### 4.5 重装插件 + 手机配对

同 3.4、3.5。手机仍然会看到证书警告（因为还没有 IP 证书），这是 P0-B 的临时状态。

## 5. P1：签 IP 证书，消除警告/关校验（30–60 分钟）

> 详细命令见 [ip-feasibility.md](ip-feasibility.md) 第 4.1、7 节。这里只列执行顺序。

### 5.1 升级 certbot（服务器）

```bash
systemctl disable --now certbot.timer
apt-get remove -y certbot
snap install certbot --classic
ln -sf /snap/bin/certbot /usr/local/bin/certbot
certbot --version          # 需要 >= 5.4
```

### 5.2 staging → 正式签 IP 证书

```bash
certbot certonly --staging \
  --preferred-profile shortlived \
  --webroot -w /usr/local/compose/www \
  --ip-address <SERVER_IP> \
  --cert-name <SERVER_IP>-staging

certbot delete --cert-name <SERVER_IP>-staging

certbot certonly \
  --preferred-profile shortlived \
  --webroot -w /usr/local/compose/www \
  --ip-address <SERVER_IP> \
  --cert-name <SERVER_IP> \
  --deploy-hook 'docker exec nginx nginx -s reload'
```

检查续期配置里保留了 `preferred_profile = shortlived`；跑 `certbot renew --cert-name <SERVER_IP> --dry-run`，同时跑一次 `certbot renew --cert-name <PUBLIC_DOMAIN> --dry-run` 确认域名证书没被升级弄坏。

### 5.3 加 nginx IP server

把 [server-ip.conf.example](../deploy/nginx/server-ip.conf.example) 的内容上传为服务器 `conf.d/server-ip.conf`，然后：

```bash
docker exec nginx nginx -t
docker exec nginx nginx -s reload
```

### 5.4 验证证书（不再需要 -k）

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<SERVER_IP>/dsh-pair   # 200
echo | openssl s_client -connect <SERVER_IP>:443 2>/dev/null | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'
```

### 5.5 关掉临时关校验

- **P0-B 做过**：
  - 把 `.env` 的 `DSH2PHONE_ALLOW_INVALID_CERT` 改回 `0`；
  - Startup 副本 `dsh2phone-tunnel.vbs` 里删掉 `TUNNEL_INSECURE`；
  - 重启 supervisor、重装插件/切换启用；
  - `tunnel.log` 应仍出现 `relay online`（这次是校验证书的）。
- **P0-A**：没有关校验要关；手机下次打开 IP 页面应直接是有效证书。如果仍显示旧警告，关掉浏览器标签重开（**不要清站点数据**）。

### 5.6 无需二次配对

IP origin 没变，`dshdev` 与 DSH cookie 继续有效；证书更换不影响 cookie。正常情况下**不需要二次配对**；如果 P0 时浏览器因证书错误没把 cookie 存下来，重新配一次即可。

### 5.7 建议顺手把 PC 侧也切到 IP（可选但推荐）

如果域名已确认不恢复，P1 后把 `.env` 的 `RELAY_URL`、`PUBLIC_PAIR_URL` 改成 `wss://<SERVER_IP>/dsh-tunnel` / `https://<SERVER_IP>/dsh-pair`（`DSH2PHONE_ALLOW_INVALID_CERT=0`，**不要** `TUNNEL_INSECURE`），并确认 Startup 副本不再自带旧 `RELAY_URL`。这样系统彻底不依赖域名；手机无需重新配对。

## 6. 验证清单

- [ ] 手机 IP `/dsh/`：有锁、应用渲染、会话列表、发消息、审批、刷新/重连正常。
- [ ] 插件“配对手机”二维码内容是 `https://<SERVER_IP>/dsh-pair?...`。
- [ ] 服务器 `healthz` = `tunnel:online`；`tunnel.log` 最近 `relay online`。
- [ ] `curl https://<SERVER_IP>/dsh-pair` 无 `-k` 返回 200（P1 后）。
- [ ] 证书 SAN 含 `IP Address:<SERVER_IP>`。
- [ ] `certbot renew --dry-run` 对 IP 和域名都通过。
- [ ] 设备页确认当前手机条目（可能被 UA 去重复用）；未误删；旧主屏幕图标已删除。

## 7. 回滚

| 场景 | 动作 |
|---|---|
| P0-A 配对失败，想回域名 | 恢复 `cordis.patch.yml`/`pair.cmd` 备份 → 重装插件 → 手机重新扫域名二维码（需域名可用） |
| P0-B 后想回域名 | 恢复 6 个备份（含 Startup VBS）→ 重启 supervisor → 重装插件 → 手机重新配对 |
| P1 证书出问题 | 保留 `server-ip.conf`；临时恢复 `TUNNEL_INSECURE`/`allowInvalidCert` 恢复访问，再修证书 |
| 域名恢复 | 可保留 IP 为主；若要回域名，手机需重新配对（origin 变了） |

**域名 `server.conf` 始终不要动**，IP server 是新增块；回滚只需改客户端。

## 8. 时间线（建议）

| 时间 | 动作 |
|---|---|
| 0–2 min | 确认 healthz/tunnel；手机试 IP 页面；备份 |
| 2–10 min | P0-A：改 `publicKeyUrl`/`pair.cmd` → 重装插件 → 手机 Chrome 配对 |
| 10–15 min | 验证手机；确认设备条目（暂不清理） |
| 15–60 min | P1：certbot 升级 → staging/正式 IP 证书 → nginx IP block → 验证 |
| 60+ min | 关掉临时关校验；PC 侧切 IP（可选）；加证书到期监控 |

如果手机浏览器无法跳过证书警告，**不要卡在 P0**：直接用 Chrome，或先做 P1（30–60 分钟）拿有效证书。

## 9. 风险与注意事项

- **P0-B 的 `TUNNEL_INSECURE`/`allowInvalidCert` 是临时状态**：会暴露 `DSH_TUNNEL_KEY` 与全部流量的 MITM 风险；P1 后必须关掉。
- **不要改 `authority`**：保持 `127.0.0.1:43120`；不要改 nginx 的 `Host 127.0.0.1:43120` / `Origin ""`。
- **不要清站点数据**：会删掉刚配对的 IP cookie，需要重新配对。
- **插件配置缓存**：改完必须重装/切换启用；否则二维码还是旧域名。
- **设备去重**：relay 会按 UA 复用已有设备，IP 配对可能不新增条目；不要按“旧域名设备”误删，否则会把当前手机一起吊销。
- **VBS supervisor 旧 env**：只杀 node 不够，要重启 supervisor。
- **6 天证书**：P1 后必须确认 timer + deploy hook + 到期监控；否则 6 天后手机 HTTPS 会挂。
- **IP 变更**：证书、二维码、客户端配置全失效；用 EIP，保留域名作为备份身份。
- **域名恢复也不要立刻切回**：origin 变化会导致再次配对；IP 稳定后保持 IP 为主。

## 10. 需要你确认

1. 域名是“**手机侧**不可用”，还是“PC 侧也不可用/不再续费”？（决定 P0-A 还是 P0-B）
2. 是否接受 P0 阶段手机出现证书警告（30–60 分钟），还是直接等 P1 证书？
3. 是否同意升级服务器 certbot（snap/venv）并新增 nginx IP server？
4. 是否要我现在按 **P0-A** 执行（改配置 → 重装插件 → 指导手机配对），P1 随后做？
