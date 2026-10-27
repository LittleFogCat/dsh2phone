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

    // ------------------------------------------------------------ pairing dialog
    function PairView({ api, t }) {
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
          setSnap(await api.pairStart());
        } catch (err) {
          setStartError(messageOf(err));
        }
      }, [api]);

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
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        panelRef.current?.focus();
      }, []);

      const tabs = ['pair', 'devices'];
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
        tabs.map((value) => h('button', {
          type: 'button',
          key: value,
          role: 'tab',
          className: `d2p-tab${tab === value ? ' d2p-tabActive' : ''}`,
          'aria-selected': tab === value,
          onClick: () => setTab(value),
        }, t(value === 'pair' ? '配对' : '设备管理')))),
      tab === 'pair' ? h(PairView, { api, t }) : h(DevicesPanel, { api, t }));
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
