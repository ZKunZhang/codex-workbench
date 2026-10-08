import { test, expect } from '@playwright/test';

test('message Markdown renders highlighted code, copies exact content and contains mobile overflow', async ({ page, request }) => {
  const code = [
    'const existingRole = roleResult.roles.find((role) => role.role_id === roleType);',
    '',
    'if (!existingRole || !existingRole.id) {',
    '  navigateTo({',
    '    url: `/subpages/talentEducation/profileForm/index?mode=create&roleType=${roleType}`,',
    '  });',
    '}',
  ].join('\n');
  const detail = await (await request.get('/api/threads/demo/task-idle')).json();
  detail.items = [{ id: 'markdown-sample', turnId: 'md-turn', type: 'agentMessage', title: 'Codex', text: '使用 `roleType` 判断已有角色：\n\n```ts\n' + code + '\n```\n\n| 情况 | 操作 |\n| --- | --- |\n| 无角色 | 创建档案 |\n\n<img src=x onerror=alert(1)>\n\n[不安全链接](javascript:alert%281%29)' }];
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedCode = text; } } }); });
  await page.route('**/api/threads/demo/task-idle', route => route.fulfill({ json: detail }));
  await page.goto('/');
  await page.getByRole('button', { name: /修复上传组件的错误提示/ }).click();
  const block = page.locator('.code-block');
  await expect(block.locator('.code-block-head')).toContainText('ts');
  await expect(block.locator('pre')).toHaveText(code + '\n');
  await expect(block.locator('.hljs-keyword').first()).toHaveText('const');
  await expect(page.locator('.markdown table')).toBeVisible();
  await expect(page.locator('.markdown img,.markdown script,.markdown a[href^="javascript:"]')).toHaveCount(0);
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__copiedCode)).toBe(code + '\n');
  await page.screenshot({ path: 'test-results/markdown-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await block.scrollIntoViewIfNeeded();
  expect(await block.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/markdown-mobile.png', fullPage: true });
});

test('desktop: approvals, questions, messages, interruption, history and request guards', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('演示模式 · 当前显示模拟任务')).toBeVisible();
  await expect(page.locator('.task-row')).toHaveCount(5);
  await expect(page.getByRole('button', { name: /权限确认/ })).toContainText('2');
  await page.getByRole('button', { name: /权限确认/ }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '允许本次' })).toBeVisible();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: /优化课程管理的搜索体验/ }).click();
  await expect(page.getByRole('button', { name: '允许本次' })).toBeVisible();
  await expect(page.locator('.conversation .request-card')).toHaveCount(0);
  await page.locator('.conversation').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.approval-panel').getByRole('button', { name: '允许本次' })).toBeVisible();
  await expect(page.locator('.task-list .thread-identity')).toHaveCount(0);
  await expect(page.locator('.detail-identity')).toContainText('Session ID');
  await expect(page.locator('.detail-identity')).toContainText('CODEX_HOME');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.getByRole('button', { name: '允许本次' }).click();
  await expect(page.getByRole('button', { name: '允许本次' })).toHaveCount(0);
  await page.getByRole('button', { name: /整理网站首页的内容结构/ }).click();
  await page.getByRole('radio', { name: /产品介绍/ }).check();
  await page.getByRole('button', { name: '提交回答' }).click();
  await expect(page.getByRole('button', { name: '提交回答' })).toHaveCount(0);
  await page.getByRole('button', { name: /修复上传组件的错误提示/ }).click();
  await page.getByRole('textbox', { name: '给 Codex 发送指令' }).fill('请检查这次修复');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('演示回复：指令已收到，任务执行完成。')).toBeVisible({ timeout: 12000 });
  await page.getByRole('button', { name: /为订单导出添加进度提示/ }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '给 Codex 发送指令' }).fill('下一步补充说明');
  await page.getByRole('button', { name: '加入队列' }).click();
  await expect(page.getByText('等待本轮结束', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('发送已暂停', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /检查构建脚本与依赖/ }).click();
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '给 Codex 发送指令' })).toBeEnabled();
  const unauthorized = await request.post('/api/threads/demo/task-idle/message', { data: { text: 'bad' } });
  expect(unauthorized.status()).toBe(403);
  const hostile = await request.get('/api/session', { headers: { Origin: 'https://evil.example' } });
  expect(hostile.status()).toBe(403);
  const leaked = await request.get('/.workbench/state.json'); expect(leaked.status()).toBe(404);
  expect(errors).toEqual([]);
});

test('nested subagents, source filtering, searchable IDs and external terminal presentation', async ({ page, request }) => {
  const original = await (await request.get('/api/session')).json();
  const base = original.snapshot.threads.find((t: { id: string }) => t.id === 'task-history');
  const root = { ...base, id: 'root-session', sessionId: 'root-session', key: 'demo:root-session', parentId: null, title: '主任务设计', codexHome: '/demo/default', externalPid: null };
  const child = { ...root, id: 'child-session', key: 'demo:child-session', parentId: root.id, title: '检索子代理' };
  const grandchild = { ...child, id: 'grandchild-session', key: 'demo:grandchild-session', parentId: child.id, title: '校对子代理' };
  const external = { ...root, sourceId: 'api', key: 'api:root-session', title: 'API 独立任务', codexHome: '/demo/api-config', state: 'idle', externalPid: 1234 };
  const snapshot = { ...original.snapshot, pending: [], threads: [root, child, grandchild, external], sources: [{ ...original.snapshot.sources[0], codexHome: '/demo/default' }, { ...original.snapshot.sources[0], id: 'api', name: 'API 配置', codexHome: '/demo/api-config', terminalAddress: 'unix:///demo/api-config/app-server-control/app-server-control.sock' }] };
  await page.route('**/api/session', route => route.fulfill({ json: { token: original.token, snapshot, capabilities: original.capabilities } }));
  await page.routeWebSocket('**/events', ws => { ws.send(JSON.stringify(snapshot)); });
  let resumeCount = 0;
  await page.route('**/api/threads/**', route => {
    if (route.request().url().endsWith('/resume')) {
      resumeCount++;
      return route.fulfill(resumeCount === 1 ? { status: 400, json: { error: '原独立终端仍持有此会话，请先 /exit' } } : { json: { ...external, externalPid: null, subscribed: true } });
    }
    return route.fulfill({ json: { thread: root, turns: [], items: [], warning: null, nextCursor: null } });
  });
  await page.goto('/');
  await expect(page.locator('.root-node > .task-entry > .task-row')).toHaveCount(2);
  await expect(page.locator('.task-children .task-row')).toHaveCount(2);
  await page.getByRole('button', { name: '收起 主任务设计 的子代理', exact: true }).click();
  await expect(page.locator('.task-children .task-row')).toHaveCount(0);
  await page.getByRole('button', { name: '展开 主任务设计 的子代理', exact: true }).click();
  await expect(page.locator('.task-children .task-row')).toHaveCount(2);
  await page.getByRole('textbox', { name: '搜索任务或项目' }).fill('child-session');
  await expect(page.locator('.root-node > .task-entry > .task-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /主任务设计/ }).first()).toBeVisible();
  await page.getByRole('button', { name: '所有任务', exact: true }).click();
  await page.getByRole('combobox', { name: '按 CODEX_HOME 筛选' }).selectOption('api');
  await expect(page.locator('.task-row')).toHaveCount(1);
  await page.getByRole('button', { name: /API 独立任务/ }).click();
  await expect(page.locator('.detail-identity')).toContainText('/demo/api-config');
  await expect(page.locator('.detail-identity')).toContainText('root-session');
  await expect(page.locator('.external-session')).toBeVisible();
  await expect(page.getByRole('button', { name: '连接会话', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除对话', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '接入交互', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('/exit');
  await expect(page.locator('.terminal-command pre')).toContainText("CODEX_HOME='/demo/api-config' codex --remote 'unix:///demo/api-config/app-server-control/app-server-control.sock' resume 'root-session'");
  await page.getByRole('button', { name: '接入面板', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('原独立终端仍持有');
  await page.getByRole('button', { name: '接入面板', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '给 Codex 发送指令' })).toBeEnabled();
  expect(resumeCount).toBe(2);
  await page.getByRole('combobox', { name: '按 CODEX_HOME 筛选' }).selectOption('demo');
  await page.getByRole('button', { name: /检索子代理/ }).first().click();
  await expect(page.locator('.detail-identity')).toContainText('Thread ID');
  await expect(page.locator('.detail-identity')).toContainText('child-session');
  await page.screenshot({ path: 'test-results/nested-tasks.png', fullPage: true });
});

test('mobile: list, detail navigation and readable viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.page-heading, .overview')).toHaveCount(0);
  await page.getByRole('button', { name: '展开左侧菜单' }).click();
  await expect(page.getByRole('button', { name: '所有任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '所有任务', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.task-row').first()).toBeVisible();
  await page.locator('.task-row').first().click();
  await expect(page.getByRole('button', { name: '返回任务列表' })).toBeVisible();
  await expect(page.locator('.message-text').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '返回任务列表' }).click();
  await expect(page.locator('.task-row').first()).toBeVisible();
});

test('sidebar preference, complete task view and confirmed conversation deletion', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.page-heading, .overview')).toHaveCount(0);
  const width = await page.locator('.workspace').evaluate(el => el.clientWidth);
  await page.getByRole('button', { name: '折叠左侧菜单' }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  expect(await page.locator('.workspace').evaluate(el => el.clientWidth)).toBeGreaterThan(width);
  await page.reload();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button', { name: '展开左侧菜单' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索任务或项目' }).fill('no-matches');
  await page.getByRole('checkbox', { name: '子代理' }).uncheck();
  await page.getByRole('button', { name: '所有任务', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或项目' })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: '子代理' })).toBeChecked();
  await expect(page.locator('.task-row')).toHaveCount(5);

  await page.locator('.topbar').getByRole('button', { name: '新建会话' }).click();
  await page.getByLabel('项目目录').fill('/tmp');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(6);
  await page.locator('.detail-heading').getByRole('button', { name: '收藏任务', exact: true }).click();
  await page.getByRole('button', { name: '删除对话', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无法撤销');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(6);

  const { token, snapshot } = await (await request.get('/api/session')).json();
  const created = snapshot.threads.find((t: { cwd: string }) => t.cwd === '/tmp');
  const endpoint = `/api/threads/demo/${created.id}/delete`;
  expect((await request.post(endpoint, { data: { confirm: true } })).status()).toBe(403);
  expect((await request.post(endpoint, { headers: { 'X-Workbench-Token': token }, data: {} })).status()).toBe(400);
  await page.getByRole('button', { name: '删除对话', exact: true }).click();
  // Failure must keep both the confirmation and the conversation visible.
  await page.route(`**${endpoint}`, route => route.fulfill({ status: 400, json: { error: '删除测试失败，请重试' } }));
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('删除测试失败，请重试');
  await expect(page.locator('.task-row')).toHaveCount(6);
  await page.unroute(`**${endpoint}`);
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.task-row')).toHaveCount(5);
  await expect(page.locator('.detail-empty')).toBeVisible();
  await page.reload();
  await expect(page.locator('.task-row')).toHaveCount(5);
  const favorites: string[] = await page.evaluate(() => JSON.parse(localStorage.getItem('codex-workbench:favorites') || '[]'));
  expect(favorites).not.toContain(`demo:${created.id}`);
  await page.screenshot({ path: 'test-results/updated-desktop.png', fullPage: true });
});
