import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from '../src/MessageMarkdown.tsx';

const render = (text: string) => renderToStaticMarkup(createElement(MessageMarkdown, { text }));
test('TypeScript fences render as highlighted code, preserving template strings and indentation', () => {
  const html = render('```ts\nconst existingRole = roleResult.roles.find((role) => role.role_id === roleType);\n\nif (!existingRole || !existingRole.id) {\n  navigateTo({\n    url: `/profileForm/index?mode=create&roleType=${roleType}`,\n  });\n}\n```');
  assert.match(html, /class="code-block"/);
  assert.match(html, /<pre><code class="hljs language-ts"/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /\n  /);
  assert.match(html, /复制代码/);
  assert(!html.includes('```'));
});
test('tables, inline code, unknown languages and incomplete streamed fences remain readable', () => {
  assert.match(render('| 名称 | 值 |\n| --- | --- |\n| id | `role.id` |'), /<table>/);
  assert.match(render('```custom-lang\na < b\n'), /a &lt; b/);
  assert.match(render('```ts\nconst value = 1;'), /<pre>/);
});
test('message HTML and unsafe link protocols do not become executable DOM', () => {
  const html = render('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n[危险](javascript:alert%281%29)\n\n```html\n<script>alert(3)</script>\n```');
  assert(!html.includes('<script'));
  assert(!html.includes('<img'));
  assert(!html.includes('href="javascript:'));
  assert.match(html, /&lt;/);
});

test('large code blocks preserve complete text without allocating highlighting spans', () => {
  const source = 'const value = 123;\n'.repeat(1000);
  const html = render('```ts\n' + source + '```');
  assert.match(html, /no-highlight/);
  assert(!html.includes('hljs-keyword'));
  assert.equal(html.split('const value = 123;').length - 1, 1000);
  assert.match(html, /复制代码/);
});
