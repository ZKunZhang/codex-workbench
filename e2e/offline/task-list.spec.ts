import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Workbench } from '../../server/workbench.ts';
import { StateStore } from '../../server/state.ts';
import { DemoConnection } from '../../server/demo.ts';

async function offlineWorkbench(page: Page, legacy = false, extraThreads = 0) {
  const client = new DemoConnection();
  client.threads.push(...Array.from({ length: extraThreads }, (_, i) => ({ ...client.threads.find(t => t.id === 'task-history')!, id: `extra-${i}`, name: `历史任务 ${i}` })));
  client.threads.push({ ...client.threads.find(t => t.id === 'task-history')!, id: 'history-child', parentThreadId: 'task-history', name: '历史子任务' });
  client.turns.set('history-child', []);
  const other = new DemoConnection();
  other.threads = [{ ...other.threads.find(t => t.id === 'task-history')!, name: '其他配置的记录' }];
  const folder = await mkdtemp(join(tmpdir(), 'workbench-offline-ui-'));
  const workbench = new Workbench([{ id: 'demo', name: '默认配置', socket: '/demo/app-server.sock' }, { id: 'api', name: 'API 配置' }], new StateStore(join(folder, 'state.json')), true, source => source.id === 'demo' ? client : other);
  workbench.start();
  await expect.poll(() => workbench.snapshot().sources.every(source => !!source.lastSync)).toBe(true);
  await page.routeWebSocket('ws://workbench.test/events', socket => {
    const update = (snapshot = workbench.snapshot()) => socket.send(JSON.stringify(snapshot));
    workbench.on('change', update); update();
    socket.onClose(() => workbench.off('change', update));
  });
  await page.route('http://workbench.test/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    try {
      if (path === '/api/session') return route.fulfill({ json: { token: 'offline-test-token', snapshot: workbench.snapshot(), ...(legacy ? {} : { capabilities: { renameThread: true, detachThread: true } }) } });
      if (path.startsWith('/api/threads/')) {
        const [, , , source, id, action] = path.split('/').map(decodeURIComponent);
        if (route.request().method() === 'GET') return route.fulfill({ json: await workbench.detail(source, id, url.searchParams.get('cursor') || undefined, url.searchParams.get('refresh') === '1') });
        const body = route.request().postDataJSON();
        if (action === 'delete' && body.confirm === true) return route.fulfill({ json: await workbench.deleteThread(source, id) });
        if (action === 'rename') return route.fulfill({ json: await workbench.rename(source, id, body.title) });
        if (action === 'detach' && body.confirm === true) return route.fulfill({ json: await workbench.detach(source, id) });
        if (action === 'resume') return route.fulfill({ json: await workbench.resume(source, id) });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'offline test: unexpected endpoint' } });
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (file !== 'index.html' && !/^assets\/[\w.-]+\.(css|js)$/.test(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: resolve('dist', file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    } catch (error) { return route.fulfill({ status: 400, json: { error: (error as Error).message } }); }
  });
  await page.goto('/');
  await expect(page.locator('.task-row')).toHaveCount(7 + extraThreads);
  return Object.assign(() => workbench.stop(), { client, workbench });
}

test('list deletion preserves another selected conversation and draft, handles failure, and removes descendants only in its source', async ({ page }) => {
  const stop = await offlineWorkbench(page);
  try {
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    const draft = page.getByRole('textbox', { name: '给 Codex 发送指令' });
    await draft.fill('当前任务的未发送内容');
    const remove = page.getByRole('button', { name: '删除对话：检查构建脚本与依赖', exact: true });
    await expect(page.getByRole('button', { name: '删除对话：为订单导出添加进度提示', exact: true })).toBeDisabled();
    await expect(page.locator('.task-row button')).toHaveCount(0);
    await remove.click();
    await expect(page.getByRole('dialog')).toContainText('检查构建脚本与依赖');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(draft).toHaveValue('当前任务的未发送内容');
    await expect(page.locator('.detail-title h2')).toHaveText('修复上传组件的错误提示');
    await page.route('**/api/threads/demo/task-history/delete', route => route.fulfill({ status: 400, json: { error: '删除失败，请重试' } }));
    await remove.click();
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('删除失败，请重试');
    await expect(page.locator('.task-row')).toHaveCount(7);
    await page.unroute('**/api/threads/demo/task-history/delete');
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.task-row')).toHaveCount(5);
    await expect(page.locator('.task-row[data-thread-id="history-child"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删除对话：其他配置的记录', exact: true })).toBeVisible();
    await expect(draft).toHaveValue('当前任务的未发送内容');
    await expect(page.locator('.detail-title h2')).toHaveText('修复上传组件的错误提示');
  } finally { stop(); }
});

test('deleting the selected child through its parent clears detail and favorites; list controls remain compact', async ({ page }) => {
  const stop = await offlineWorkbench(page);
  try {
    await page.locator('.task-row[data-thread-id="history-child"]').click();
    await page.locator('.detail-heading').getByRole('button', { name: '收藏任务', exact: true }).click();
    await expect(page.locator('.task-children .task-delete')).toBeVisible();
    await expect(page.locator('.task-list .thread-identity')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/list-delete-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '删除对话：检查构建脚本与依赖', exact: true }).click();
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    await expect(page.locator('.detail-empty')).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('codex-workbench:favorites'))).toBe('[]');
  } finally { stop(); }
});

test('mobile delete buttons and title editing remain accessible without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stop = await offlineWorkbench(page);
  try {
    await expect(page.getByRole('button', { name: '删除对话：历史子任务', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/list-delete-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    await page.getByRole('button', { name: '修改标题', exact: true }).click();
    await page.getByRole('textbox', { name: '对话标题', exact: true }).fill('手机上修改后的标题');
    await page.getByRole('button', { name: '保存标题', exact: true }).click();
    await expect(page.locator('.detail-title h2')).toHaveText('手机上修改后的标题');
    await page.getByRole('button', { name: '返回任务列表', exact: true }).click();
    await expect(page.getByRole('button', { name: '删除对话：手机上修改后的标题', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '删除对话：历史子任务', exact: true }).click();
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    await expect(page.locator('.task-row[data-thread-id="history-child"]')).toHaveCount(0);
    await expect(page.locator('.task-row[data-thread-id="task-history"]')).toHaveCount(2);
  } finally { stop(); }
});

test('an older running backend explicitly requires restart instead of offering a broken rename action', async ({ page }) => {
  const stop = await offlineWorkbench(page, true);
  try {
    await expect(page.getByRole('status')).toContainText('工作台后台版本较旧');
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    await expect(page.getByRole('button', { name: '修改标题', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '修改标题', exact: true })).toHaveAttribute('title', '请重启工作台服务以启用修改标题');
  } finally { stop(); }
});

test('idle reads slow down, hidden pages stop polling while approvals stay live, and manual refresh bypasses cache', async ({ page }) => {
  await page.clock.install();
  const stop = await offlineWorkbench(page);
  const reads: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/threads/demo/task-idle')) reads.push(request.url()); });
  try {
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    await expect(page.locator('.conversation .message')).not.toHaveCount(0);
    const initial = reads.length;
    expect(initial).toBe(1);
    await page.clock.runFor(29_000); expect(reads.length).toBe(initial);
    await page.clock.runFor(2000); await expect.poll(() => reads.length).toBe(initial + 1);
    await page.getByRole('button', { name: '刷新会话', exact: true }).click();
    await expect.poll(() => reads.some(url => url.endsWith('?refresh=1'))).toBe(true);
    await expect(page.getByRole('button', { name: '刷新会话', exact: true })).toBeEnabled();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const beforeHidden = reads.length;
    await page.clock.runFor(70_000); expect(reads.length).toBe(beforeHidden);
    stop.client.emit('request', { id: 'hidden-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'task-idle', turnId: 'turn-task-idle', itemId: 'hidden-command', command: 'test -d .', cwd: '/test', kind: 'command' } });
    await expect(page.locator('.request-card .command-preview').filter({ hasText: 'test -d .' })).toBeVisible();
    expect(reads.length).toBe(beforeHidden);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => reads.length).toBe(beforeHidden + 1);
  } finally { stop(); }
});

test('slow detail reads never overlap and switching tasks cancels obsolete rendering without losing the new draft', async ({ page }) => {
  await page.clock.install();
  const stop = await offlineWorkbench(page);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  await page.route('**/api/threads/demo/task-running', async route => { reads++; await pending; await route.fallback(); });
  try {
    await page.locator('.task-row[data-thread-id="task-running"]').click();
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(15_000); expect(reads).toBe(1);
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    const draft = page.getByRole('textbox', { name: '给 Codex 发送指令' });
    await draft.fill('保留这个草稿');
    finish();
    await expect(page.locator('.detail-title h2')).toHaveText('修复上传组件的错误提示');
    await expect(draft).toHaveValue('保留这个草稿');
    expect(reads).toBe(1);
  } finally { finish(); stop(); }
});

test('idle sessions expose terminal, detach and close controls; exiting preserves history and can reconnect', async ({ page }) => {
  const stop = await offlineWorkbench(page);
  try {
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    const actions = page.locator('.detail-heading').getByRole('button', { name: '会话操作', exact: true });
    const panel = page.getByRole('group', { name: '会话操作', exact: true });
    await expect(panel).toHaveCount(0);
    await actions.click();
    await expect(page.getByRole('button', { name: '退出面板连接', exact: true })).toBeEnabled();
    await page.screenshot({ path: 'test-results/session-actions-desktop.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(actions).toBeFocused();
    await actions.click();
    await page.locator('.detail-title h2').click();
    await expect(panel).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '关闭导航菜单', exact: true }).click({ position: { x: 380, y: 422 } });
    await actions.click();
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'test-results/session-actions-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '终端与面板交互', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText("codex --remote 'unix:///demo/app-server.sock' resume 'task-idle'");
    await expect(panel).toHaveCount(0);
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const tool = page.locator('.tool-item').first();
    await expect(tool).toBeVisible(); await expect(tool.locator('pre')).toHaveCount(0);
    await tool.locator('summary').click(); await expect(tool.locator('pre')).toHaveCount(1);
    await tool.locator('summary').click(); await expect(tool.locator('pre')).toHaveCount(0);
    await actions.click();
    await page.getByRole('button', { name: '退出面板连接', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('其他终端会继续运行');
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('.detail-empty')).toBeVisible();
    await expect(page.locator('.task-row[data-thread-id="task-idle"]')).toHaveCount(1);
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    await expect(page.getByRole('button', { name: '重新接入', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '给 Codex 发送指令' })).toHaveCount(0);
    await page.getByRole('button', { name: '重新接入', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '给 Codex 发送指令' })).toBeVisible();
    await page.getByRole('button', { name: '会话操作', exact: true }).click();
    await page.getByRole('button', { name: '关闭当前对话', exact: true }).click();
    await expect(page.locator('.conversation')).toHaveCount(0);
    await page.locator('.task-row[data-thread-id="task-running"]').click();
    await actions.click();
    await expect(page.getByRole('button', { name: '退出面板连接', exact: true })).toBeDisabled();
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    await expect(panel).toHaveCount(0);
  } finally { stop(); }
});

test('long histories keep one bounded page in memory and release the conversation when closed', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const stop = await offlineWorkbench(page);
  const thread = stop.workbench.snapshot().threads.find(thread => thread.key === 'demo:task-history')!;
  const code = 'const value = someFunction(123, "example");\n'.repeat(300);
  await page.route('**/api/threads/demo/task-history*', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const offset = Number(new URL(route.request().url()).searchParams.get('cursor') || 0);
    return route.fulfill({ json: { thread, turns: [], items: Array.from({ length: 60 }, (_, i) => ({ id: `message-${offset + i}`, turnId: 'long-turn', type: 'agentMessage', title: 'Codex', text: `记录 ${offset + i}\n\n\`\`\`ts\n${code}\`\`\`` })), nextCursor: offset < 660 ? String(offset + 60) : null, warning: null } });
  });
  const cdp = await page.context().newCDPSession(page);
  const sample = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const [heap, dom] = await Promise.all([cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters')]);
    return { usedHeapBytes: heap.usedSize, nodes: dom.nodes, documents: dom.documents };
  };
  try {
    await page.locator('.task-row[data-thread-id="task-history"]').first().click();
    await expect(page.locator('.conversation .message')).toHaveCount(60);
    await expect(page.locator('.conversation .hljs-keyword')).toHaveCount(0);
    const first = await sample();
    for (let i = 0; i < 11; i++) {
      await page.getByRole('button', { name: '更早一页', exact: true }).click();
      await expect(page.locator('.history-navigation')).toContainText(`第 ${i + 2} 页`);
      await expect(page.locator('.conversation .message')).toHaveCount(60);
    }
    const last = await sample();
    expect(last.nodes).toBeLessThan(first.nodes + 1500);
    expect(last.usedHeapBytes).toBeLessThan(first.usedHeapBytes + 12 * 1024 * 1024);
    await page.getByRole('button', { name: '较新一页', exact: true }).click();
    await expect(page.locator('.history-navigation')).toContainText('第 11 页');
    await page.getByRole('button', { name: '回到最新', exact: true }).click();
    await expect(page.locator('.conversation .message').first()).toContainText('记录 0');
    await page.getByRole('button', { name: '会话操作', exact: true }).click();
    await page.getByRole('button', { name: '关闭当前对话', exact: true }).click();
    await expect(page.locator('.conversation .message')).toHaveCount(0);
    const closed = await sample();
    expect(closed.nodes).toBeLessThan(last.nodes);
    await testInfo.attach('memory-sample.json', { body: JSON.stringify({ scenario: '12 pages, 60 large code messages per page; Chromium forced GC, not live-user process RSS', first, last, closed }, null, 2), contentType: 'application/json' });
  } finally { await cdp.detach(); stop(); }
});

test('large task lists keep drafts and child tasks intact through updates to one task', async ({ page }, testInfo) => {
  const stop = await offlineWorkbench(page, false, 301);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m: { name: string; value: number }) => [m.name, m.value]));
  try {
    await page.locator('.task-row[data-thread-id="task-idle"]').click();
    const draft = page.getByRole('textbox', { name: '给 Codex 发送指令' });
    await draft.fill('更新期间保留草稿');
    const snapshot = JSON.parse(JSON.stringify(stop.workbench.snapshot()));
    const thread = snapshot.threads.find((thread: { id: string }) => thread.id === 'task-running');
    const before = await metrics();
    for (let i = 0; i < 30; i++) {
      thread.title = `正在执行 ${i}`;
      snapshot.revision++;
      snapshot.sources.forEach((source: { lastSync: number }) => { source.lastSync++; });
      stop.workbench.emit('change', snapshot);
      await expect(page.locator('.task-row[data-thread-id="task-running"] h3')).toHaveText(thread.title);
    }
    const after = await metrics();
    await expect(page.locator('.task-row')).toHaveCount(308);
    await expect(page.locator('.task-children .task-row[data-thread-id="history-child"]')).toHaveCount(1);
    await expect(draft).toHaveValue('更新期间保留草稿');
    const samplePath = testInfo.outputPath('cpu-sample.json');
    await writeFile(samplePath, JSON.stringify({ scenario: 'Chromium, 308 tasks, 30 snapshots updating one task; accumulated browser main-thread seconds, not live Safari CPU percentage', taskSeconds: after.TaskDuration - before.TaskDuration, scriptSeconds: after.ScriptDuration - before.ScriptDuration, layoutSeconds: after.LayoutDuration - before.LayoutDuration }, null, 2));
    await testInfo.attach('cpu-sample.json', { path: samplePath, contentType: 'application/json' });
  } finally { await cdp.detach(); stop(); }
});
