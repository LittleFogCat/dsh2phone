# 对话回复推送：可行性评估

> 日期：2026-11-25
> 问题：对话有回复时，能不能给手机发一条推送？
> 结论：**能**。触发点在 DSH 里有公开的 Cordis 事件，缺的只是"最后一公里"的投递通道；而那一段没有免费的午餐——手机系统必须有一条常驻连接或厂商通道。
>
> 本文只做评估与设计，没有改代码。文中域名/IP 一律用占位符。

---

## 0. 结论与推荐

| 层 | 方案 | 能否离线收到 | 工作量 | 建议 |
|---|---|---|---|---|
| 触发 | 插件监听 `session/event` 的 `turn/end` | — | 半天 | 必做，且已由第三方插件（dsh-qqbot）验证可行 |
| 投递（推荐） | 自建 **ntfy**（服务器一个容器） | 能 | 总计 0.5–1 天 | 先做这个 |
| 投递（无服务端） | 企业微信 / 钉钉 / 飞书群机器人 webhook | 能 | 30 分钟 | 不想动服务器时用它 |
| 投递（要 App 原生通知） | MobiDSH 集成 **UnifiedPush**（ntfy App 当分发器） | 能 | +1–2 天 | 第二步 |
| 投递（要免保活、系统级） | 厂商推送（极光/个推/华为/小米） | 能 | 1–3 天 + 账号/合规 | 只有真要产品化才做 |
| **排除** | Web Push (VAPID)、FCM | 国内不能 | — | 不要碰，见 §2 |

一句话：**插件负责"知道回复完了"，ntfy 负责"把通知送到息屏的手机上"**，两段都不需要改 relay 和 App。

---

## 1. 触发点：DSH 侧的"回复完成"事件

### 1.1 事件契约（来自当前安装版 0.2.2-rc.3 的文档）

```ts
// docs/subsystems/session.md — 公开事件
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
'session/event' 里 event.type === 'turn/end'
'turn/end': { turn: number; reason: TurnEndReason }
// reason.kind: completed | aborted | blocked | error | 'max-tokens' | interrupted | forked

// 回复正文：'assistant/message'
'assistant/message': { turn; step; message: AssistantMessage; stream; usage?; interrupted? }
// message.content 里的 { type: 'text', text } 就是可见回复
```

- 该事件是**持久会话事件**的同步广播；`turn/*`、`step/*`、`tool/*` 都不是同名 Cordis 事件，必须挂在 `session/event` 上再判 `event.type`（`docs/user/develop/framework/events.md` 明确写了这一点）。
- 已有生产级先例：profile 里的 `@tencent-connect/dsh-qqbot` 就是 `ctx.on('session/event', …)` + `ctx.on('agent/assistant-stream', …, { global: true })`，把 QQ 会话和 DSH 会话对起来。说明这条链路不是理论可行。
- 备选触发是 `agent/status` 的 `idle` 转换，但它表示"驱动空闲"，不是"这一轮回复结束"（一个 turn 里可能有多次 step），且不带结束原因。**优先用 `turn/end`**。

### 1.2 插件里的代码形状（草案，未提交）

```js
// host.js apply() 里
const lastText = new Map();      // sessionId -> 最近一条 assistant 文本
const lastSent = new Map();      // sessionId -> 上次推送时间（去抖）

ctx.on("session/event", (session, event) => {
  const id = session?.id;
  if (!id) return;

  if (event.type === "assistant/message") {
    const text = (event.data?.message?.content ?? [])
      .filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (text) lastText.set(id, text);
    return;
  }

  if (event.type !== "turn/end") return;
  if (event.data?.reason?.kind !== "completed") { lastText.delete(id); return; }

  const header = session.header ?? {};
  if (header.parentSession !== undefined) return;      // 子代理会话不推
  if ((header.delegationDepth ?? 0) > 0) return;       // 同上，双保险

  const text = lastText.get(id) ?? "";
  lastText.delete(id);
  if (!text) return;                                   // 没有可见正文的轮次不推
  if (Date.now() - (lastSent.get(id) ?? 0) < 3000) return;
  lastSent.set(id, Date.now());

  // 关键：session/event 是同步广播，绝不能 await 网络
  queueMicrotask(() => sendPush({ title: titleOf(session), body: text.slice(0, 120) }));
}, { global: true });
```

几个实现细节（都是坑）：

1. **监听器必须非阻塞**。`session/event` 是同步通知（持久化后端就在这条路径上），HTTP 请求要放到队列/微任务里，失败只记日志。
2. **`{ global: true }` 要带上**。作用域过滤会把 agent 作用域里的监听器限定到该 agent；qqbot 对 `agent/assistant-stream` 就是显式 `{ global: true }`。如果发现收不到，先查这里。
3. **过滤子代理**：`session.header` 有 `parentSession` / `delegationDepth` / `origin` / `cwd` / `agentPreset`，用前两个就能排除 subagent 会话，否则一次委派会刷一串通知。
4. **标题**：`SessionHeader` 不含标题（标题是独立投影），最省事的做法是 `basename(session.header.cwd)`，有正文时再截前 20 字。
5. **去抖**：goal 续跑、连续追问会让 `turn/end` 密集出现，按 sessionId 3–5 秒去抖。
6. **手机正在用时不要吵**：可选加一个 `pushPing` Remote（client.js 每 20 秒心跳），host 记录"最近 90 秒有手机在线"，在这个窗口内跳过推送。不加也能用，只是自己在手机上提问时会收到重复通知。

### 1.3 唯一需要实测的点

根作用域的 `ctx.on('session/event')` 是否收得到**别的插件创建的会话**（GUI 会话由 web-app/agent-loop 创建）。持久化后端就是"安装一次、接收所有会话"，所以答案是肯定的；但真机验证时先跑一个小探针：打开一个普通会话发一句话，看 `turn/end` 是否进日志/是否被插件收到。改动 `host.js` 需要重启 Desktop（见 HANDOFF 第六节坑 7）。

---

## 2. 最后一公里：通道对比（为什么只有那几条路）

| 通道 | 息屏/App 被杀能收到 | 国内网络 | 新增依赖 | 工作量 | 备注 |
|---|---|---|---|---|---|
| 自建 **ntfy** + ntfy App | 能 | 能 | 服务器 +1 容器、nginx +1 server | 0.5–1 天 | **推荐**；内容不出自己的服务器 |
| ntfy.sh 公共实例 | 能 | 一般可用（需实测） | 无 | 30 分钟 | topic 即密码；内容过第三方 |
| 企业微信/钉钉/飞书群机器人 | 能 | 能 | 一个 webhook URL | 30 分钟 | 消息落在聊天软件里，内容过第三方 |
| Web Push (VAPID) | 名义上能 | **不能** | SW + VAPID 密钥 | — | Chrome 的 Web Push 走 FCM，国内直连不通；同类项目 dsh-pocket 在 v1.0.20 专门把 Web Push 删了，就是这个原因 |
| FCM 直连（App 内） | 能 | **不能** | Firebase 工程 + google-services.json | — | 国产 ROM 普遍无 GMS；排除 |
| 厂商推送（极光/个推/华为/小米） | 能（系统级） | 能 | 开发者账号 + SDK + 隐私合规 | 1–3 天 | 唯一"免保活"的路，产品化才值 |
| MobiDSH 自研长连接 | 能 | 能 | 前台服务 + 重连 + 电池白名单 | 2–3 天 | 本质是重新实现一遍 ntfy |
| App 内通知（页面活着时） | **不能** | 能 | 仅一个 JS bridge | 0.5 天 | 只能算补充层 |

两条硬事实：

1. **WebView 不支持 Web Push**。MobiDSH 是受控 WebView（`mobile/README.md` 也写明"不要把它当后台常驻客户端"），`ServiceWorker` + `PushManager` 在 WebView 里拿不到系统通知通道；页面一退到后台、进程一被回收就没了。
2. **Android 上"真推送"= 一条由系统/常驻服务维持的连接**。要么交给 Google（FCM，国内不可用），要么交给厂商通道（要资质），要么交给一个愿意长期占据前台服务的 App（ntfy/Gotify 就是干这个的）。

---

## 3. 方案 A（推荐）：自建 ntfy

### 3.1 链路

```
DSH Desktop（dsh2phone 插件）
   │  turn/end → POST https://push.<PUBLIC_DOMAIN>/<topic>
   ▼
nginx  push.<PUBLIC_DOMAIN>  →  ntfy 容器 (:80, behind-proxy)
   ▲
   │  WebSocket（ntfy App 的 instant delivery，不需要 Google）
手机 ntfy App ──► 系统通知（点击打开 https://<PUBLIC_DOMAIN>/dsh/）
```

### 3.2 服务器侧

`deploy/server/docker-compose.yml` 加一个服务（和现有 nginx 在同一 compose 网络里，按服务名访问）：

```yaml
  ntfy:
    image: binwiederhier/ntfy
    restart: unless-stopped
    command: serve
    environment:
      NTFY_BASE_URL: "https://push.<PUBLIC_DOMAIN>"
      NTFY_BEHIND_PROXY: "true"
      NTFY_CACHE_FILE: "/var/lib/ntfy/cache.db"
      NTFY_CACHE_DURATION: "24h"
      NTFY_AUTH_FILE: "/var/lib/ntfy/auth.db"
      NTFY_AUTH_DEFAULT_ACCESS: "deny-all"
    volumes:
      - "./data/ntfy:/var/lib/ntfy"
    # 不映射宿主端口：nginx 容器和它在同一个 compose 网络里，按服务名访问
```

最好的入口是**独立子域** `push.<PUBLIC_DOMAIN>`（同一张证书再签一张，或泛域名）：

```nginx
server {
    server_name push.<PUBLIC_DOMAIN>;
    location / {
        proxy_pass http://ntfy:80;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;   # WebSocket 订阅不能被 60s 掐断
    }
}
```

只在现有域名下挂路径（`/dsh-push/`）也能工作——**publish 和订阅走的是剥了前缀的路径**，只要 nginx 写 `proxy_pass http://ntfy:80/;`（注意结尾斜杠）并把 `base-url` 设成带前缀的地址即可。但 ntfy 的 Web UI 在子路径下并不完整（上游 issue #1009），所以只当订阅端用没问题，别指望在浏览器里点它。

建用户与 token（token 只给插件用，写权限够；手机侧用订阅用的凭证）：

```bash
docker exec ntfy ntfy user add --role=admin <ADMIN>
docker exec ntfy ntfy access everyone 'dsh2phone-*' deny   # 匿名一律拒绝
docker exec ntfy ntfy token add <ADMIN>                     # → tk_xxx
```

> ntfy 的 REST 语义：`POST /<topic>` 发消息，头 `Title` / `Priority` / `Tags` / `Click` 可用；更稳的是发 JSON 到 `POST /`（`{topic,title,message,priority,tags,click}`），中文标题不会遇到 HTTP 头编码问题。token 用 `Authorization: Bearer tk_…`。

### 3.3 插件侧

新增配置键（按 AGENTS.md §1.1，需同步 `.env`、`.env.example`、`tools/check-env.mjs`、README）：

| 键 | 说明 |
|---|---|
| `DSH2PHONE_PUSH_URL` | `https://push.<PUBLIC_DOMAIN>`（或带前缀的 `/dsh-push`），留空 = 关闭推送 |
| `DSH2PHONE_PUSH_TOPIC` | 随机串（topic 即密码），如 `dsh2phone-7f3a…` |
| `DSH2PHONE_PUSH_TOKEN` | ntfy token（`tk_…`），只写权限 |
| `DSH2PHONE_PUSH_BODY` | `1` 带回复摘要 / `0` 只推"会话完成"（默认 1） |
| `DSH2PHONE_PUSH_CLICK` | 默认用 `PUBLIC_PAIR_URL` 的 origin + `/dsh/` |

推送体（JSON）：

```json
{
  "topic": "dsh2phone-7f3a…",
  "title": "dsh2phone · 回复完成",
  "message": "（工作区名）回复摘要前 120 字…",
  "priority": 3,
  "tags": ["whale"],
  "click": "https://<PUBLIC_DOMAIN>/dsh/"
}
```

实现要点：`fetch` 5 秒超时、失败重试 1 次、日志打 `[dsh2phone] push` 前缀、**永不抛出**（监听器在事件主路径上）。`configSave` / `configGet` 里加这几个键，设置页多一个"推送"分区（可选，先走 `.env` 也行）。

### 3.4 手机侧

1. 装 ntfy App（F-Droid / GitHub Release，国产商店也有），"添加订阅"填 `https://push.<PUBLIC_DOMAIN>/<topic>` 和 token。
2. 打开 **instant delivery**（WebSocket 模式，不依赖 Google）。
3. 给 ntfy 关掉电池优化（小米/华为/OPPO 还要"允许自启动 / 无限制"），否则息屏几分钟后连接会被杀——这是这条路唯一的运维成本。

### 3.5 送达语义

- 手机断网期间 ntfy 会缓存（`cache-duration`，示例给了 24h），恢复后补推，不会丢。
- 多台手机订阅同一 topic = 全部收到；想只给某台推，就每台一个 topic。
- 点击通知只能打开 `/dsh/` 入口：DSH 前端是单路由，不写 URL 历史（HANDOFF §1.2 的返回键结论），**目前无法深链到具体会话**。要深链得先给 Web 客户端加 `?session=` 支持，属于 P2。

---

## 4. 方案 B：App 内通知（零服务端，作为补充层）

思路：`client.js` 在页面里已经能收到会话事件（也可由 host 通过事件推给 client），检测到"本轮回复完成 且 页面不可见（`document.visibilityState !== 'visible'`）"时，调用 MobiDSH 已有的 `Dsh2PhoneNative` bridge，发一条本地通知。

- 成本：App 加一个 `NotificationChannel` + `notify(title, body, intent)`（约 60 行 Java），`client.js` 加约 30 行；不需要任何服务器。
- 覆盖：App 还在后台、进程没被杀的那几分钟到几十分钟。
- 不覆盖：息屏久了、系统回收进程、用户手动划掉——这些只有方案 A/C 能救。
- 结论：**成本极低，建议和方案 A 一起做**，作为"没配 ntfy 也能收到"的兜底。

---

## 5. 方案 C：真·原生推送

两条路，都不便宜：

1. **UnifiedPush**：MobiDSH 加 `org.unifiedpush.android:connector` 依赖，注册成分发器的接收方，通知由 App 自己发出（自家图标、可深链），连接仍由 ntfy App 维持。pc 侧还是同一条 HTTP POST。代价：需要把 endpoint 从手机送回插件（App 设置页"复制推送地址"→ 插件设置页粘贴，或经 relay 注册），约 1–2 天。
2. **厂商推送 / 极光、个推**：系统级、免保活、免装第三方 App，但需要开发者账号、应用签名登记、隐私合规声明，且各厂商通道行为不一。1–3 天起步，适合真当产品发。

判断标准：如果你能接受"手机上多一个 ntfy App"，就不需要 C；只有当"必须只有一个 App"时才值得。

---

## 6. 工作量与验证

| 项 | 估时 |
|---|---|
| 插件触发 + 降噪 + 配置 + 设置页 | 0.5 天 |
| ntfy 容器 + nginx + token（服务器） | 0.5 天 |
| 单测（纯函数：格式化 / 过滤 / 去抖） | 2 小时 |
| `tools/plugin-push-check.mjs`（起本地 HTTP sink，发一条真实推送验证 200 + 内容） | 2 小时 |
| App 内通知（方案 B） | 0.5 天 |
| UnifiedPush（方案 C1） | 1–2 天 |

按仓库规矩要同步的地方：`host.js`（新增 Remote 需进 `markRemote` 列表）、`client.js` 的 `createApi`、`tools/plugin-smoke.mjs` 的 `expected` 数组、`.env` / `.env.example` / `tools/check-env.mjs` / README 配置表、`CHANGELOG.md` + 版本号（minor，新增能力）。`host.js` 改动必须重启 Desktop 才生效。

验证顺序：

1. `node tools/plugin-push-check.mjs --dry` 只验纯函数；
2. 起一个本地 sink（`node -e` 的 http server），在 `.env` 里把 `DSH2PHONE_PUSH_URL` 指过去，发一句话，看请求体；
3. 换成真 ntfy，手机息屏 5 分钟后再发一句，确认能收到；
4. 回归：`npm test`（check-env + plugin-config-check + plugin-smoke）。

---

## 7. 隐私与边界

- **内容出不出本机**：方案 A 自建时不出；ntfy.sh / 企业微信 / 钉钉都会经过第三方，介意就用 `DSH2PHONE_PUSH_BODY=0` 只推"会话完成"。
- **topic 即密码**，配 `auth-default-access: deny-all` + token；`.env` 已有忽略规则，token 不入库。
- **推送是写权限**：token 泄露最多被人往你的 topic 灌消息，拿不到 DSH；但别复用 pairing/relay 的密钥。
- **噪音**：后台 goal 续跑、subagent、并发会话都会产生 `turn/end`。默认策略：只推 root 会话、只推 `completed`、每会话 3 秒去抖、正文为空不推。
- **DSH 升级风险**：`session/event` / `turn/end` 是公开文档化的契约（`dsh-qqbot` 也在用同一条链路），风险低；但 `host.js` 改动需重启 Desktop，升级后先看 `[dsh2phone]` 日志。
- **不做的**：不为了推送在 relay 上加长连接协议，也不在 App 里自己保活——那是重复实现 ntfy 且会和省电策略打架。

---

## 8. 建议落地顺序

1. **先 30 分钟验证价值链**：插件里写死一个 ntfy.sh 随机 topic（临时测试用），发一句话，确认手机 ntfy App 能收到、点击能开 `/dsh/`。
2. 把服务器上的自建 ntfy 补齐（§3.2），配置键落进 `.env`，按 §6 的清单同步文档与测试。
3. 顺手加方案 B（App 内通知），覆盖"没配 ntfy"的场景。
4. 真要"只有一个 App"再评估 UnifiedPush（§5.1）。
