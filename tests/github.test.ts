import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'src', 'index.ts');

function withMockGh(
  args: string[],
  options: { exitCode?: number } = {},
) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-gh-test-'));
  const binDir = path.join(temp, 'bin');
  const argsFile = path.join(temp, 'gh-args.txt');
  mkdirSync(binDir);

  const mockGh = path.join(binDir, 'gh');
  writeFileSync(
    mockGh,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "gh version test"',
      '  exit 0',
      'fi',
      'printf "%s\\n" "$@" > "$GH_ARGS_FILE"',
      'exit "${GH_TEST_EXIT_CODE:-0}"',
      '',
    ].join('\n'),
  );
  chmodSync(mockGh, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, ...args],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          GH_ARGS_FILE: argsFile,
          GH_TEST_EXIT_CODE: String(options.exitCode ?? 0),
        },
      },
    );

    const recordedArgs = readFileSync(argsFile, 'utf8').trim().split('\n');
    return { result, recordedArgs };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('gh-issues forwards the selected state and result limit', () => {
  const { result, recordedArgs } = withMockGh(['gh-issues', 'all']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedArgs, ['issue', 'list', '--state', 'all', '--limit', '30']);
});

test('gh-prs forwards merged state and result limit', () => {
  const { result, recordedArgs } = withMockGh(['gh-prs', 'merged']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedArgs, ['pr', 'list', '--state', 'merged', '--limit', '30']);
});

test('gh-runs forwards a bounded run-list request', () => {
  const { result, recordedArgs } = withMockGh(['gh-runs']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedArgs, ['run', 'list', '--limit', '20']);
});

test('GitHub commands report non-zero gh exit statuses', () => {
  const { result } = withMockGh(['gh-issues'], { exitCode: 7 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub CLI exited with status 7/);
});

test('GitHub issue command rejects unsupported state values', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, 'gh-issues', 'pending'],
    { cwd: projectRoot, encoding: 'utf8', timeout: 15_000 },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: dev-assistant gh-issues/);
});
