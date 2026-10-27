// Shared GUI entry helpers: the pairing entry lives in the sidebar-foot account
// popup (设置 / 意见反馈 / 配对手机 / 退出登录), not beside it.
//
// The account launcher is the only sidebar button with a `data-signed-out`
// attribute (its own trigger marks the signed-in state); the pairing row is the
// one element this plugin grafts into that popup.
export const accountTrigger = (page) => page.locator('button[aria-haspopup="menu"][data-signed-out]').first();

export const pairMenuItem = (page) => page.locator('[data-d2p-menu-entry]').first();

/** Open the account popup and click the 配对手机 row. */
export async function openPairDialog(page) {
  await accountTrigger(page).click();
  const item = pairMenuItem(page);
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
}
