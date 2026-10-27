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
