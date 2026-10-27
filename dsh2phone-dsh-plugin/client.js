// Client half of the dsh2phone plugin (browser module).
//
// Registers:
//   shell.overlay → the pairing dialog (QR / confirm / devices whitelist)
//
// Entry point: a "配对手机" row inside the sidebar-foot account popup (设置 /
// 意见反馈 / 退出登录), not a button beside it. DSH publishes no menu-item slot
// for that popup, so the row is grafted into the portaled [role="menu"] list —
// see installAccountMenuEntry for the narrow DOM contract and its fallback.
//
// All host operations go through Typert Remote calls on namespace "dsh2phone".
// UI is plain React with hand-styled controls using only --dsw-alias-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh2phone',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh2phone';

    // ---------------------------------------------------------------- locale
    const en = {
      '配对手机': 'Pair phone',
      '配对': 'Pairing',
      '设备管理': 'Devices',
      '用手机扫码，在手机上完成接入确认。': 'Scan with your phone, then confirm access on this computer.',
      '配对码': 'Pairing code',
      '有效期 {time}': 'Valid for {time}',
      '等待手机扫码…': 'Waiting for the phone to scan…',
      '新设备请求接入': 'A new device is asking for access',
      '设备：{name}': 'Device: {name}',
      'IP：{ip}': 'IP: {ip}',
      '该设备已在白名单，确认后将刷新授权。': 'This device is already paired; confirming refreshes its access.',
      '拒绝': 'Deny',
      '允许接入': 'Allow',
      '已允许，请在手机上点击“进入 DSH”。': 'Allowed. Tap “Enter DSH” on your phone.',
      '已拒绝该设备。': 'The device was denied.',
      '配对码已过期。': 'The pairing code has expired.',
      '配对已取消。': 'Pairing was cancelled.',
      '配对会话已断开。': 'The pairing session was disconnected.',
      '重新配对': 'Pair again',
      '查看设备': 'View devices',
      '手机上的入口页可添加到主屏幕，下次直接进入。': 'Add the entry page to your phone’s home screen for next time.',
      '刷新': 'Refresh',
      '全部吊销': 'Revoke all',
      '确认全部吊销？': 'Revoke all devices?',
      '确认': 'Confirm',
      '启用': 'Allow',
      '停用': 'Deny',
      '移除': 'Remove',
      '确认移除？': 'Remove?',
      '已允许': 'allowed',
      '已停用': 'denied',
      '最后在线 {time} · IP {ip}': 'Last seen {time} · IP {ip}',
      '暂无已配对设备。': 'No paired devices yet.',
      '正在加载…': 'Loading…',
      '关闭': 'Close',
      '设置': 'Settings',
      '还缺配置': 'Configuration incomplete',
      '填好下面的连接信息后会自动回到配对。': 'Fill in the connection details below; pairing resumes automatically.',
      '中继地址': 'Relay URL',
      '配对地址': 'Pairing URL',
      '隧道密钥': 'Tunnel key',
      '中继地址 RELAY_URL': 'Relay URL (RELAY_URL)',
      '配对地址 PUBLIC_PAIR_URL': 'Pairing URL (PUBLIC_PAIR_URL)',
      '隧道密钥 DSH_TUNNEL_KEY': 'Tunnel key (DSH_TUNNEL_KEY)',
      'authority DSH_AUTHORITY': 'authority (DSH_AUTHORITY)',
      '有效期 DSH2PHONE_TTL_DAYS': 'TTL (DSH2PHONE_TTL_DAYS)',
      '已设置（{mask}）': 'set ({mask})',
      '生成密钥': 'Generate key',
      '显示': 'Show',
      '隐藏': 'Hide',
      '保存并应用': 'Save and apply',
      '已保存': 'Saved',
      '保存失败': 'Save failed',
      '已写入 {file}': 'Written to {file}',
      '被真实环境变量覆盖，需重启 Desktop：{names}': 'overridden by real environment variables; restart Desktop: {names}',
      '测试连通性': 'Test connectivity',
      '本机 DSH': 'Local DSH',
      '控制面（relay）': 'Control plane (relay)',
      '公网配对页': 'Public pairing page',
      '正常': 'OK',
      '失败': 'failed',
      '耗时 {ms} ms': '{ms} ms',
      '已配对 {n} 台设备': '{n} device(s) paired',
      'HTTP {status}': 'HTTP {status}',
      '高级': 'Advanced',
      'authority': 'authority',
      '有效期（天）': 'TTL (days)',
      '跳过证书校验（relay 用 IP 直连时）': 'Skip certificate verification (relay addressed by IP)',
      '配置文件': 'Config file',
      '来自 .env': 'from .env',
      '来自插件配置': 'from plugin config',
      '来自密钥文件': 'from key file',
      '默认值': 'default',
      '部署命令': 'Deployment commands',
      '这些命令在服务器上执行，插件不会替你 SSH。': 'Run these on the server; the plugin never SSHes for you.',
      '复制': 'Copy',
      '已复制': 'Copied',
      '打开设置': 'Open settings',
      'locale.code': 'en',
    };
    const zh = { ...Object.fromEntries(Object.keys(en).map((key) => [key, key])), 'locale.code': 'zh-CN' };

    // ------------------------------------------------- shared dialog open state
    const store = {
      open: false,
      listeners: new Set(),
      setOpen(value) {
        if (store.open === value) return;
        store.open = value;
        for (const listener of [...store.listeners]) listener();
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      getSnapshot() {
        return store.open;
      },
    };

    // ------------------------------------------------------------------- host API
    function createApi(rpc) {
      const call = async (method, args = {}) => {
        const result = await rpc.call('/api', `${NS}/${method}`, { args });
        if (!result.ok) throw new Error(result.error?.message ?? '插件连接暂不可用，请重试。');
        return result.value;
      };
      return {
        pairStart: () => call('pairStart'),
        pairInspect: (id) => call('pairInspect', { id }),
        pairRespond: (id, reqId, approved) => call('pairRespond', { id, reqId, approved }),
        pairCancel: (id) => call('pairCancel', { id }),
        devicesList: () => call('devicesList'),
        devicesSet: (id, status) => call('devicesSet', { id, status }),
        devicesRemove: (id) => call('devicesRemove', { id }),
        devicesPanic: () => call('devicesPanic'),
        configGet: () => call('configGet'),
        configSave: (patch) => call('configSave', { patch }),
        newTunnelKey: () => call('newTunnelKey'),
        probe: () => call('probe'),
      };
    }

    function messageOf(err) {
      return err?.message ?? String(err);
    }

    // ------------------------------------------------------------------- styles
    const CSS = `
.d2p-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:16px}
.d2p-dialog{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;width:min(420px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:18px 20px 20px;box-shadow:0 18px 48px rgba(0,0,0,.25)}
.d2p-dialog:focus{outline:none}
.d2p-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.d2p-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.d2p-close{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.d2p-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.d2p-tabs{display:flex;gap:6px;margin-top:14px}
.d2p-tab{padding:5px 12px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.d2p-tab:hover{color:var(--dsw-alias-label-primary)}
.d2p-tabActive{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.d2p-qrWrap{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:18px;text-align:center}
.d2p-qr{border-radius:12px;width:min(240px,100%);height:auto;display:block;background:#fff}
.d2p-status{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px;overflow-wrap:anywhere}
.d2p-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:15px;letter-spacing:2px;color:var(--dsw-alias-label-primary)}
.d2p-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.d2p-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:16px}
.d2p-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.d2p-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.d2p-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.d2p-btn:disabled{opacity:.55;cursor:default}
/* Filled with the brand color, so the label must be the *inverted* label token:
   brand-primary is near-black in light mode but near-white in dark mode, and a
   hard-coded #fff disappears on the dark-mode fill (white on white). */
.d2p-btnPrimary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.d2p-btnPrimary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-label-primary-inverted))}
.d2p-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.d2p-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary);font-size:13px;overflow-wrap:anywhere}
.d2p-success{margin:10px 0 0;color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary));font-size:13px;overflow-wrap:anywhere}
.d2p-deviceList{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.d2p-device{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.d2p-deviceHead{display:flex;align-items:center;gap:8px;justify-content:space-between}
.d2p-deviceName{font-size:13.5px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.d2p-badge{flex:none;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid}
/* 11px text needs ≥4.5:1, which raw state colors do not reach on a white card
   (success green is ~2:1). Mix the state hue toward the label color: darker in
   light mode, lighter in dark mode, so the badge stays legible either way. */
.d2p-badgeAllow{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.d2p-badgeDeny{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.d2p-meta{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.d2p-deviceActions{display:flex;gap:6px;margin-top:2px;flex-wrap:wrap}
.d2p-mini{padding:3px 10px;border-radius:6px;font-size:12px}
.d2p-empty{color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;padding:18px 0;margin:0}
.d2p-toolbar{display:flex;justify-content:flex-end;margin-top:12px}
/* settings tab — inputs sit on a translucent label tint so the same rules work
   on both the light and the dark dialog surface without hard-coded colors. */
.d2p-banner{margin-top:12px;padding:9px 11px;border-radius:9px;font-size:12.5px;line-height:1.55;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.d2p-bannerBad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.d2p-banner b{font-weight:600}
.d2p-form{display:flex;flex-direction:column;gap:11px;margin-top:14px}
.d2p-field{display:flex;flex-direction:column;gap:4px}
.d2p-label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.d2p-src{font-size:10.5px;opacity:.75;flex:none}
.d2p-input{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:7px 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);
  color:var(--dsw-alias-label-primary)}
.d2p-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.d2p-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.d2p-inputBad{border-color:var(--dsw-alias-state-error-primary)}
.d2p-fieldErr{margin:0;font-size:11.5px;color:var(--dsw-alias-state-error-primary)}
.d2p-inline{display:flex;gap:6px;align-items:stretch}
.d2p-inline .d2p-input{flex:1;min-width:0}
.d2p-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px}
.d2p-check{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.d2p-check input{accent-color:var(--dsw-alias-brand-primary)}
.d2p-testList{display:flex;flex-direction:column;gap:6px;margin:12px 0 0;padding:0;list-style:none}
.d2p-testRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:7px 9px;border-radius:8px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);font-size:12.5px;color:var(--dsw-alias-label-primary)}
.d2p-testName{overflow-wrap:anywhere}
.d2p-testWhere{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow-wrap:anywhere}
.d2p-ok{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-label-primary))}
.d2p-bad{color:var(--dsw-alias-state-error-primary)}
.d2p-details{margin-top:14px;font-size:12.5px}
.d2p-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.d2p-details summary:hover{color:var(--dsw-alias-label-primary)}
.d2p-pre{margin:8px 0 0;padding:10px;border-radius:8px;overflow:auto;white-space:pre;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.65}
.d2p-path{margin:10px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
`;

    function StyleTag() {
      return h('style', null, CSS);
    }

    // --------------------------------------------------- sidebar account menu row
    //
    // The sidebar foot opens the account popup (设置 / 意见反馈 / 退出登录). Its rows
    // are built inside @deepseek-ai/dsh-client-ui-settings-account and no slot
    // contributes to them, so the pairing row is grafted into the popup's own
    // list: a sibling `button[role="menuitem"]` inside the portaled
    // `[role="menu"]` that carries the settings row plus a sign-in/out row.
    //
    // Contract (see the account plugin's AccountMenu): the list is portaled to
    // <body>, rows are icon+label buttons with role="menuitem", and the
    // sign-in/out row is last. The new row is a clone of a shipped row, so it
    // inherits that popup's classes, metrics and hover/focus treatment instead
    // of a second copy of its CSS. Keep the match narrow so no other menu is
    // touched, and re-apply on every portal mount because React drops foreign
    // children on re-render.
    const MENU_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<rect x="5.25" y="1.75" width="5.5" height="12.5" rx="1.6"></rect>'
      + '<line x1="6.9" y1="11.9" x2="9.1" y2="11.9"></line></svg>';

    // Localized row labels of the account popup, used only to recognise it.
    const MENU_ROWS = {
      settings: ['设置', 'Settings'],
      feedback: ['意见反馈', 'Feedback'],
      auth: ['退出登录', 'Sign out', '登录', 'Sign in', '正在退出…', 'Signing out…'],
    };

    function rowText(element) {
      return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    // A row's text also carries its shortcut ("设置Ctrl+Alt+,"), so membership is
    // a containment check, not equality.
    function rowMatches(text, group) {
      return MENU_ROWS[group].some((word) => text.includes(word));
    }

    function findAccountMenu() {
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (menu.querySelector('[data-d2p-menu-entry]') !== null) return menu;
        const rows = Array.from(menu.querySelectorAll('button[role="menuitem"]'), rowText);
        const has = (group) => rows.some((text) => rowMatches(text, group));
        if (rows.length >= 2 && has('settings') && (has('auth') || has('feedback'))) return menu;
      }
      return null;
    }

    function menuListHost(menu) {
      for (const child of menu.children) {
        if (child.getAttribute('role') === 'presentation') return child;
      }
      return menu;
    }

    // Mount the row in whichever account popup is open. The sign-in/out row
    // anchors it to the tail of the list, so the popup reads
    // 设置 / 意见反馈 / 配对手机 / 退出登录.
    function installAccountMenuEntry({ t, open, subscribe }) {
      let row = null;
      let rowLabel = null;
      let frame = 0;
      let disposed = false;

      const paint = () => {
        if (row === null) return;
        const label = t('配对手机');
        row.setAttribute('aria-label', label);
        if (rowLabel !== null) rowLabel.textContent = label;
      };

      const build = (reference) => {
        const button = reference.cloneNode(true);
        button.dataset.d2pMenuEntry = '';
        button.removeAttribute('aria-keyshortcuts');
        button.disabled = false;
        const spans = Array.from(button.children).filter((child) => child.tagName === 'SPAN');
        const icon = spans.find((span) => span.querySelector('svg') !== null) ?? null;
        const label = spans.find((span) => span !== icon) ?? null;
        for (const span of spans) {
          if (span !== icon && span !== label) span.remove();
        }
        if (icon !== null) icon.innerHTML = MENU_ICON;
        rowLabel = label;
        button.addEventListener('click', (event) => {
          event.preventDefault();
          // Dismiss the popup through its own Escape contract: both layers sit at
          // the sidebar foot and the portaled list would cover the dialog.
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
          }));
          window.setTimeout(open, 0);
        });
        return button;
      };

      const sync = () => {
        frame = 0;
        if (disposed) return;
        const menu = findAccountMenu();
        if (menu === null) {
          row = null;
          rowLabel = null;
          return;
        }
        if (row !== null && menu.contains(row)) {
          paint();
          return;
        }
        const host = menuListHost(menu);
        const rows = Array.from(host.querySelectorAll('button[role="menuitem"]'));
        const reference = rows.find((candidate) => rowMatches(rowText(candidate), 'settings'))
          ?? rows.find((candidate) => rowMatches(rowText(candidate), 'feedback'))
          ?? null;
        if (reference === null) {
          row = null;
          rowLabel = null;
          return;
        }
        const tail = rows.find((candidate) => rowMatches(rowText(candidate), 'auth')) ?? null;
        row = build(reference);
        if (tail === null) {
          host.append(row);
        } else if (tail.parentElement?.parentElement === host) {
          host.insertBefore(row, tail.parentElement);
        } else {
          host.insertBefore(row, tail);
        }
        paint();
      };

      // The popup is portaled to <body>, so a body-level childList observer sees
      // it appear and disappear; one graft per animation frame is enough. A click
      // is the one other way it opens, so re-check then too — that also covers a
      // future portal container the childList rule would not see.
      const schedule = () => {
        if (disposed || frame !== 0) return;
        frame = window.requestAnimationFrame(sync);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true });
      document.addEventListener('click', schedule, true);
      sync();
      const unsubscribe = subscribe(paint);

      return () => {
        disposed = true;
        unsubscribe();
        observer.disconnect();
        document.removeEventListener('click', schedule, true);
        if (frame !== 0) window.cancelAnimationFrame(frame);
        frame = 0;
        row = null;
        rowLabel = null;
        for (const node of document.querySelectorAll('[data-d2p-menu-entry]')) node.remove();
      };
    }

    // ---------------------------------------------------------------- devices view
    function DevicesPanel({ api, t }) {
      const [devices, setDevices] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [armRemove, setArmRemove] = React.useState(null);
      const [armPanic, setArmPanic] = React.useState(false);

      const load = React.useCallback(async () => {
        setError(null);
        setBusy(true);
        try {
          setDevices((await api.devicesList()).devices);
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      }, [api]);

      React.useEffect(() => { void load(); }, [load]);

      const act = (fn, after) => async () => {
        setBusy(true);
        setError(null);
        try {
          await fn();
          if (after) after();
          await load();
        } catch (err) {
          setError(messageOf(err));
          setBusy(false);
        }
      };

      const rows = devices ?? [];
      return h('div', null,
        h(StyleTag),
        error ? h('p', { className: 'd2p-error', role: 'alert' }, error) : null,
        devices === null && !error
          ? h('p', { className: 'd2p-empty' }, t('正在加载…'))
          : rows.length === 0
            ? h('p', { className: 'd2p-empty' }, t('暂无已配对设备。'))
            : h('div', { className: 'd2p-deviceList' }, rows.map((device) => {
                const allowed = device.status === 'allow';
                const armed = armRemove === device.id;
                return h('div', { className: 'd2p-device', key: device.id },
                  h('div', { className: 'd2p-deviceHead' },
                    h('span', { className: 'd2p-deviceName' }, device.name ?? device.id),
                    h('span', { className: `d2p-badge ${allowed ? 'd2p-badgeAllow' : 'd2p-badgeDeny'}` }, allowed ? t('已允许') : t('已停用'))),
                  h('p', { className: 'd2p-meta' }, t('最后在线 {time} · IP {ip}', {
                    time: device.lastSeen ? new Date(device.lastSeen).toLocaleString() : '-',
                    ip: device.lastIp ?? '-',
                  })),
                  h('div', { className: 'd2p-deviceActions' },
                    h('button', {
                      type: 'button', className: 'd2p-btn d2p-mini', disabled: busy,
                      onClick: act(() => api.devicesSet(device.id, allowed ? 'deny' : 'allow')),
                    }, allowed ? t('停用') : t('启用')),
                    h('button', {
                      type: 'button', className: `d2p-btn d2p-mini${armed ? ' d2p-btnDanger' : ''}`, disabled: busy,
                      onClick: armed
                        ? act(() => api.devicesRemove(device.id), () => setArmRemove(null))
                        : () => setArmRemove(device.id),
                    }, armed ? t('确认移除？') : t('移除'))));
              })),
        rows.length > 0
          ? h('div', { className: 'd2p-toolbar' },
              h('button', {
                type: 'button',
                className: `d2p-btn d2p-mini${armPanic ? ' d2p-btnDanger' : ''}`,
                disabled: busy,
                onClick: armPanic
                  ? act(() => api.devicesPanic(), () => { setArmPanic(false); setArmRemove(null); })
                  : () => setArmPanic(true),
              }, armPanic ? t('确认全部吊销？') : t('全部吊销')))
          : null);
    }

    // --------------------------------------------------------------- settings view
    const DEPLOY_COMMANDS = [
      'cd /usr/local/compose && docker compose up -d --build dsh-relay',
      'docker exec dsh-relay wget -qO- http://127.0.0.1:3201/healthz   # 期望 tunnel:online',
      'docker exec nginx nginx -t && docker exec nginx nginx -s reload',
    ].join('\n');

    const SOURCE_LABEL = {
      env: '来自 .env',
      config: '来自插件配置',
      file: '来自密钥文件',
      default: '默认值',
    };

    function SettingsPanel({ api, t, hint, onReady }) {
      const [snap, setSnap] = React.useState(null);
      const [form, setForm] = React.useState({
        relayUrl: '', publicKeyUrl: '', tunnelKey: '', authority: '', ttlDays: 30, allowInvalidCert: false,
      });
      const [showKey, setShowKey] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [errors, setErrors] = React.useState({});
      const [note, setNote] = React.useState(null);
      const [test, setTest] = React.useState(null);
      const [copied, setCopied] = React.useState(false);

      const applySnapshot = React.useCallback((value) => {
        setSnap(value);
        setForm({
          relayUrl: value?.values?.relayUrl ?? '',
          publicKeyUrl: value?.values?.publicKeyUrl ?? '',
          tunnelKey: '',
          authority: value?.values?.authority ?? '',
          ttlDays: value?.values?.ttlDays ?? 30,
          allowInvalidCert: Boolean(value?.values?.allowInvalidCert),
        });
      }, []);

      React.useEffect(() => {
        let alive = true;
        api.configGet()
          .then((value) => { if (alive) applySnapshot(value); })
          .catch((err) => { if (alive) setNote({ kind: 'error', text: messageOf(err) }); });
        return () => { alive = false; };
      }, [api, applySnapshot]);

      const set = (key) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        setForm((prev) => ({ ...prev, [key]: value }));
      };

      const save = async () => {
        setBusy(true);
        setErrors({});
        setNote(null);
        try {
          const result = await api.configSave({ ...form, ttlDays: Number(form.ttlDays) || 0 });
          if (!result.saved) {
            setErrors(Object.fromEntries((result.errors ?? []).map((item) => [item.field, item.message])));
            setNote({ kind: 'error', text: t('保存失败') });
            return;
          }
          applySnapshot(result.snapshot);
          setNote({
            kind: 'ok',
            text: result.shadowed?.length
              ? t('被真实环境变量覆盖，需重启 Desktop：{names}', { names: result.shadowed.join(', ') })
              : t('已保存'),
          });
          if ((result.issues ?? []).length === 0) onReady?.();
        } catch (err) {
          setNote({ kind: 'error', text: messageOf(err) });
        } finally {
          setBusy(false);
        }
      };

      const generate = async () => {
        setBusy(true);
        try {
          const { key } = await api.newTunnelKey();
          setForm((prev) => ({ ...prev, tunnelKey: key }));
          setShowKey(true);
          setNote({ kind: 'ok', text: t('生成密钥') });
        } catch (err) {
          setNote({ kind: 'error', text: messageOf(err) });
        } finally {
          setBusy(false);
        }
      };

      const probe = async () => {
        setBusy(true);
        setTest(null);
        setNote(null);
        try {
          setTest(await api.probe());
        } catch (err) {
          setNote({ kind: 'error', text: messageOf(err) });
        } finally {
          setBusy(false);
        }
      };

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(DEPLOY_COMMANDS);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      };

      const issues = hint?.issues ?? snap?.issues ?? [];
      const fieldIssue = (field) => errors[field] ?? issues.find((item) => item.field === field)?.message ?? null;
      const source = (key) => (snap ? SOURCE_LABEL[snap.sources?.[key]] ?? '' : '');

      const field = (key, label, extra) => h('div', { className: 'd2p-field', key },
        h('label', { className: 'd2p-label', htmlFor: `d2p-${key}` },
          h('span', null, label),
          source(key) ? h('span', { className: 'd2p-src' }, source(key)) : null),
        extra ?? h('input', {
          id: `d2p-${key}`,
          className: `d2p-input${fieldIssue(key) ? ' d2p-inputBad' : ''}`,
          value: form[key] ?? '',
          onChange: set(key),
          spellCheck: false,
          autoComplete: 'off',
          placeholder: key === 'authority' ? '127.0.0.1:43120' : '',
        }),
        fieldIssue(key) ? h('p', { className: 'd2p-fieldErr', role: 'alert' }, fieldIssue(key)) : null);

      const legs = test
        ? [
            [t('本机 DSH'), test.local, () => t('HTTP {status}', { status: test.local.status })],
            [t('控制面（relay）'), test.control, () => t('已配对 {n} 台设备', { n: test.control.devices })],
            [t('公网配对页'), test.public, () => t('HTTP {status}', { status: test.public.status })],
          ]
        : [];

      return h('div', null,
        h(StyleTag),
        hint
          ? h('p', { className: 'd2p-banner d2p-bannerBad', role: 'status' },
              h('b', null, t('还缺配置')), ' · ', t('填好下面的连接信息后会自动回到配对。'))
          : null,
        !snap && !note ? h('p', { className: 'd2p-empty' }, t('正在加载…')) : null,
        h('div', { className: 'd2p-form' },
          field('relayUrl', t('中继地址')),
          field('publicKeyUrl', t('配对地址')),
          field('tunnelKey', t('隧道密钥'), h('div', { className: 'd2p-inline' },
            h('input', {
              id: 'd2p-tunnelKey',
              className: `d2p-input${fieldIssue('tunnelKey') ? ' d2p-inputBad' : ''}`,
              type: showKey ? 'text' : 'password',
              value: form.tunnelKey,
              onChange: set('tunnelKey'),
              spellCheck: false,
              autoComplete: 'new-password',
              placeholder: snap?.values?.hasTunnelKey ? t('已设置（{mask}）', { mask: snap.values.tunnelKeyMask }) : '',
            }),
            h('button', { type: 'button', className: 'd2p-btn d2p-mini', disabled: busy, onClick: () => setShowKey((prev) => !prev) },
              showKey ? t('隐藏') : t('显示')),
            h('button', { type: 'button', className: 'd2p-btn d2p-mini', disabled: busy, onClick: () => void generate() }, t('生成密钥')))),
          h('details', { className: 'd2p-details' },
            h('summary', null, t('高级')),
            h('div', { className: 'd2p-form', style: { marginTop: 10 } },
              field('authority', t('authority')),
              field('ttlDays', t('有效期（天）'), h('input', {
                id: 'd2p-ttlDays',
                className: `d2p-input${fieldIssue('ttlDays') ? ' d2p-inputBad' : ''}`,
                type: 'number', min: 1, max: 365, value: form.ttlDays, onChange: set('ttlDays'),
              })),
              h('label', { className: 'd2p-check' },
                h('input', { type: 'checkbox', checked: form.allowInvalidCert, onChange: set('allowInvalidCert') }),
                t('跳过证书校验（relay 用 IP 直连时）'))))),
        note ? h('p', { className: note.kind === 'ok' ? 'd2p-success' : 'd2p-error', role: 'status' }, note.text) : null,
        h('div', { className: 'd2p-row' },
          h('button', { type: 'button', className: 'd2p-btn d2p-btnPrimary', disabled: busy, onClick: () => void save() }, t('保存并应用')),
          h('button', { type: 'button', className: 'd2p-btn', disabled: busy, onClick: () => void probe() }, t('测试连通性'))),
        legs.length > 0
          ? h('ul', { className: 'd2p-testList' }, legs.map(([name, result, detail]) => h('li', { className: 'd2p-testRow', key: name },
              h('span', { className: 'd2p-testName' },
                name,
                result.ok && detail ? h('span', { className: 'd2p-testWhere' }, ' · ', detail()) : null,
                !result.ok ? h('span', { className: 'd2p-testWhere' }, ' · ', result.error ?? '') : null),
              h('span', { className: result.ok ? 'd2p-ok' : 'd2p-bad' },
                result.ok ? `${t('正常')} · ${t('耗时 {ms} ms', { ms: result.ms })}` : t('失败')))))
          : null,
        snap?.envFile ? h('p', { className: 'd2p-path' }, t('配置文件'), '：', snap.envFile) : null,
        h('details', { className: 'd2p-details' },
          h('summary', null, t('部署命令')),
          h('p', { className: 'd2p-hint' }, t('这些命令在服务器上执行，插件不会替你 SSH。')),
          h('pre', { className: 'd2p-pre' }, DEPLOY_COMMANDS),
          h('div', { className: 'd2p-row', style: { marginTop: 8 } },
            h('button', { type: 'button', className: 'd2p-btn d2p-mini', onClick: () => void copy() },
              copied ? t('已复制') : t('复制')))));
    }

    // ------------------------------------------------------------ pairing dialog
    function PairView({ api, t, onConfigRequired }) {
      const [snap, setSnap] = React.useState(null);
      const [startError, setStartError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [tab, setTab] = React.useState(); // undefined | "devices": switches the dialog body
      const snapRef = React.useRef(null);
      snapRef.current = snap;
      const [now, setNow] = React.useState(Date.now());

      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);

      const start = React.useCallback(async () => {
        setStartError(null);
        setSnap(null);
        try {
          const result = await api.pairStart();
          // Incomplete configuration: hand the issues to the settings tab instead
          // of showing a dead-end error here.
          if (result?.configRequired) {
            onConfigRequired?.(result);
            return;
          }
          setSnap(result);
        } catch (err) {
          setStartError(messageOf(err));
        }
      }, [api, onConfigRequired]);

      React.useEffect(() => {
        void start();
        return () => {
          const active = snapRef.current;
          if (active && (active.status === 'pending_scan' || active.status === 'pending_confirm')) {
            api.pairCancel(active.id).catch(() => {});
          }
        };
      }, [start, api]);

      React.useEffect(() => {
        if (!snap || (snap.status !== 'pending_scan' && snap.status !== 'pending_confirm')) return;
        const timer = setInterval(() => {
          api.pairInspect(snap.id).then(setSnap).catch((err) => setStartError(messageOf(err)));
        }, 1500);
        return () => clearInterval(timer);
      }, [snap?.id, snap?.status, api]);

      const respond = async (approved) => {
        if (!snap?.request) return;
        setBusy(true);
        try {
          setSnap(await api.pairRespond(snap.id, snap.request.reqId, approved));
        } catch (err) {
          setStartError(messageOf(err));
        } finally {
          setBusy(false);
        }
      };

      const remainMs = snap ? Math.max(0, snap.expiresAt - now) : 0;
      const mmss = `${Math.floor(remainMs / 60000)}:${String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0')}`;

      if (tab === 'devices') return h(DevicesPanel, { api, t });

      const retry = h('div', { className: 'd2p-actions' },
        h('button', { type: 'button', className: 'd2p-btn d2p-btnPrimary', onClick: () => void start() }, t('重新配对')));

      let body;
      if (!snap && !startError) {
        body = h('p', { className: 'd2p-empty' }, t('正在加载…'));
      } else if (!snap) {
        body = h(React.Fragment, null,
          h('p', { className: 'd2p-error', role: 'alert' }, startError),
          retry);
      } else {
        switch (snap.status) {
          case 'pending_scan':
            body = h(React.Fragment, null,
              h('div', { className: 'd2p-qrWrap' },
                h('img', { className: 'd2p-qr', src: snap.qrImage, alt: t('配对码') }),
                h('p', { className: 'd2p-status' }, t('配对码'), ' ', h('span', { className: 'd2p-code' }, snap.code)),
                h('p', { className: 'd2p-status' }, t('有效期 {time}', { time: mmss }), ' · ', t('等待手机扫码…'))),
              snap.error ? h('p', { className: 'd2p-error', role: 'alert' }, snap.error) : null);
            break;
          case 'pending_confirm':
            body = h(React.Fragment, null,
              h('div', { className: 'd2p-qrWrap' },
                h('p', { className: 'd2p-status', style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, t('新设备请求接入')),
                h('p', { className: 'd2p-status' }, t('设备：{name}', { name: snap.request.name ?? snap.request.ua ?? '-' })),
                h('p', { className: 'd2p-status' }, t('IP：{ip}', { ip: snap.request.ip || '-' })),
                snap.request.existing ? h('p', { className: 'd2p-hint' }, t('该设备已在白名单，确认后将刷新授权。')) : null),
              snap.error ? h('p', { className: 'd2p-error', role: 'alert' }, snap.error) : null,
              h('div', { className: 'd2p-actions' },
                h('button', { type: 'button', className: 'd2p-btn', disabled: busy, onClick: () => void respond(false) }, t('拒绝')),
                h('button', { type: 'button', className: 'd2p-btn d2p-btnPrimary', disabled: busy, onClick: () => void respond(true) }, t('允许接入'))));
            break;
          case 'approved':
            body = h(React.Fragment, null,
              h('p', { className: 'd2p-success', role: 'status' }, t('已允许，请在手机上点击“进入 DSH”。')),
              h('p', { className: 'd2p-hint', style: { textAlign: 'center', marginTop: 6 } }, t('手机上的入口页可添加到主屏幕，下次直接进入。')),
              h('div', { className: 'd2p-actions' },
                h('button', { type: 'button', className: 'd2p-btn d2p-btnPrimary', onClick: () => setTab('devices') }, t('查看设备'))));
            break;
          case 'rejected':
            body = h(React.Fragment, null,
              h('p', { className: 'd2p-status' }, t('已拒绝该设备。')),
              retry);
            break;
          case 'expired':
            body = h(React.Fragment, null,
              h('p', { className: 'd2p-status' }, t('配对码已过期。')),
              retry);
            break;
          case 'closed':
            body = h(React.Fragment, null,
              h('p', { className: 'd2p-status' }, t('配对会话已断开。')),
              retry);
            break;
          default:
            body = h(React.Fragment, null, h('p', { className: 'd2p-status' }, snap.status), retry);
        }
        if (startError) {
          body = h(React.Fragment, null, body, h('p', { className: 'd2p-error', role: 'alert' }, startError));
        }
      }

      return h('div', null, h(StyleTag), body);
    }

    // The overlay occupant rendered in shell.overlay while the dialog is open.
    function PairDialog({ api, t }) {
      const [tab, setTab] = React.useState('pair');
      // Set when pairStart reports missing/placeholder configuration; the
      // settings tab then explains what to fill and returns here when ready.
      const [configHint, setConfigHint] = React.useState(null);
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        panelRef.current?.focus();
      }, []);

      const tabs = [['pair', '配对'], ['devices', '设备管理'], ['settings', '设置']];
      // Stable identities: PairView keys its start() effect on this callback, so
      // a fresh arrow every render would restart the pairing session.
      const handleConfigRequired = React.useCallback((result) => {
        setConfigHint(result);
        setTab('settings');
      }, []);
      const handleReady = React.useCallback(() => {
        setConfigHint(null);
        setTab('pair');
      }, []);
      return h('section', {
        ref: panelRef,
        className: 'd2p-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('配对手机'),
        tabIndex: -1,
      },
      h(StyleTag),
      h('div', { className: 'd2p-head' },
        h('h2', { className: 'd2p-title' }, t('配对手机')),
        h('button', {
          type: 'button', className: 'd2p-close', 'aria-label': t('关闭'),
          onClick: () => store.setOpen(false),
        }, h('svg', {
          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true,
        }, h('line', { x1: '5', y1: '5', x2: '19', y2: '19' }), h('line', { x1: '19', y1: '5', x2: '5', y2: '19' })))),
      h('div', { className: 'd2p-tabs', role: 'tablist', 'aria-label': t('配对手机') },
        tabs.map(([value, label]) => h('button', {
          type: 'button',
          key: value,
          role: 'tab',
          className: `d2p-tab${tab === value ? ' d2p-tabActive' : ''}`,
          'aria-selected': tab === value,
          onClick: () => setTab(value),
        }, t(label)))),
      tab === 'pair'
        ? h(PairView, { api, t, onConfigRequired: handleConfigRequired })
        : tab === 'devices'
          ? h(DevicesPanel, { api, t })
          : h(SettingsPanel, { api, t, hint: configHint, onReady: handleReady }));
    }

    function PairOverlay({ api, t }) {
      const open = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      React.useEffect(() => {
        if (!open) return;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            store.setOpen(false);
            return;
          }
          if (event.key !== 'Tab') return;
          const panel = document.querySelector('.d2p-dialog');
          if (!panel) return;
          const focusables = Array.from(panel.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]'))
            .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden]'));
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [open]);

      if (!open) return null;
      return h('div', {
        className: 'd2p-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) store.setOpen(false);
        },
      }, h(PairDialog, { api, t }));
    }

    // ------------------------------------------------------------------ apply
    const inject = ['slots', 'connection', 'locale'];

    function apply(ctx) {
      const services = ctx;
      ctx.effect(() => services.locale.register(NS, { zh, en }), 'dsh2phone.locale');
      const t = services.locale.bind(NS);
      const api = createApi(services.connection.rpc);
      ctx.effect(() => services.slots.inject('shell.overlay', () => services.slots.register({
        name: 'shell.overlay',
        id: 'dsh2phone',
        order: 60,
        locale: NS,
        label: () => t('配对手机'),
        inject: () => ({ api, t }),
      }, PairOverlay)), 'dsh2phone.slots');
      ctx.effect(() => installAccountMenuEntry({
        t,
        open: () => store.setOpen(true),
        subscribe: (listener) => services.locale.subscribe(listener),
      }), 'dsh2phone.menu-entry');
    }

    return { apply, inject };
  },
});
