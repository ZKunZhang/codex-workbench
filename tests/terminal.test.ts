import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { terminalCommand } from '../shared/terminal.ts';

test('copied terminal command preserves exact home and session without shell interpolation', () => {
  const home = "/tmp/home space '$literal`uname`";
  const id = "session ' $(uname)";
  const command = terminalCommand({ codexHome: home, socket: home + '/app.sock' }, id)!;
  const stub = 'codex() { printf "%s\\n" "$CODEX_HOME" "$@"; }; ';
  const output = execFileSync('/bin/bash', ['-c', stub + command], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(output, [home, '--remote', 'unix://' + home + '/app.sock', 'resume', id]);
  assert.equal(terminalCommand({}), null);
});
