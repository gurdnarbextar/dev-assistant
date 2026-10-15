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

test('gh-pr-checks requests checks for the current pull request', () => {
  const { result, recordedArgs } = withMockGh(['gh-pr-checks']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedArgs, ['pr', 'checks']);
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


function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

test('gh-pr-create forwards explicit title, body, base and draft options', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-pr-create-'));
  const binDir = path.join(temp, 'bin');
  const repo = path.join(temp, 'repo');
  const argsFile = path.join(temp, 'gh-args.txt');
  mkdirSync(binDir);
  mkdirSync(repo);

  const mockGh = path.join(binDir, 'gh');
  writeFileSync(
    mockGh,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$GH_ARGS_FILE"',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(mockGh, 0o755);

  try {
    git(repo, ['init', '-b', 'feature/pr-workflow']);
    git(repo, ['config', 'user.name', 'Dev Assistant Test']);
    git(repo, ['config', 'user.email', 'dev-assistant-test@example.invalid']);

    writeFileSync(path.join(repo, 'file.txt'), 'base\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'base commit']);

    git(repo, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    git(repo, ['update-ref', 'refs/remotes/origin/feature/pr-workflow', 'HEAD']);
    git(repo, ['branch', '--set-upstream-to=origin/feature/pr-workflow']);

    writeFileSync(path.join(repo, 'file.txt'), 'feature change\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'add feature change']);

    const result = spawnSync(
      process.execPath,
      [
        '--import', path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
        cliPath, 'gh-pr-create',
        '--title', 'Add PR workflow',
        '--body', 'Summary with spaces',
        '--base', 'main',
        '--draft',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          GH_ARGS_FILE: argsFile,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'pr',
      'create',
      '--title',
      'Add PR workflow',
      '--body',
      'Summary with spaces',
      '--head',
      'feature/pr-workflow',
      '--base',
      'main',
      '--draft',
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('gh-pr-create rejects missing title or body before invoking gh', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, 'gh-pr-create', '--title', 'Missing body'],
    { cwd: projectRoot, encoding: 'utf8', timeout: 15_000 },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: dev-assistant gh-pr-create/);
});

test('gh-pr-create refuses to create a PR from main', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', cliPath, 'gh-pr-create',
      '--title', 'Test PR',
      '--body', 'Test body',
    ],
    { cwd: projectRoot, encoding: 'utf8', timeout: 15_000 },
  );

  // This repository is expected to be on main while running its own tests.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prohibited from main\/master/);
});
