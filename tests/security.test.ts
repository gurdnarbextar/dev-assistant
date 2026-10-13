import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'index.js');

function createRepo() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-security-'));

  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'security-test@example.invalid'],
    ['config', 'user.name', 'Security Test'],
  ]) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  return {
    directory,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function runCli(directory: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: directory,
    encoding: 'utf8',
  });
}

function stageFile(directory: string, relativePath: string, content: string) {
  const fullPath = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  const result = spawnSync('git', ['add', '--', relativePath], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('security scan passes clean staged files', () => {
  const repo = createRepo();
  try {
    stageFile(repo.directory, 'src/example.ts', 'export const answer = 42;\n');
    const result = runCli(repo.directory, ['security-scan']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Security scan passed/);
  } finally {
    repo.cleanup();
  }
});

test('security scan rejects credential-like additions without printing the value', () => {
  const repo = createRepo();
  try {
    const testCredential = ['dummy-secret', 'value-12345'].join('-');
    stageFile(repo.directory, 'config.ts', `const password = "${testCredential}";\n`);
    const result = runCli(repo.directory, ['security-scan']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY SCAN FAILED/);
    assert.match(result.stderr, /Credential assignment/);
    assert.doesNotMatch(result.stderr, /not-a-real-password-123/);
  } finally {
    repo.cleanup();
  }
});

test('security scan rejects staged environment files', () => {
  const repo = createRepo();
  try {
    stageFile(repo.directory, '.env.production', 'APP_MODE=production\n');
    const result = runCli(repo.directory, ['security-scan']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sensitive environment file/);
  } finally {
    repo.cleanup();
  }
});

test('security scan rejects sensitive directories at any depth', () => {
  const repo = createRepo();
  try {
    stageFile(repo.directory, 'src/secrets/config.json', '{"example": true}\n');
    const result = runCli(repo.directory, ['security-scan']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sensitive directory/);
  } finally {
    repo.cleanup();
  }
});

test('security hook installs and uninstalls without affecting repository files', () => {
  const repo = createRepo();
  try {
    const installed = runCli(repo.directory, ['security-hook', 'install']);
    assert.equal(installed.status, 0, installed.stderr);

    const hookPath = path.join(repo.directory, '.git', 'hooks', 'pre-commit');
    assert.equal(fs.existsSync(hookPath), true);
    assert.match(fs.readFileSync(hookPath, 'utf8'), /Managed by Dev Assistant/);

    const removed = runCli(repo.directory, ['security-hook', 'uninstall']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(hookPath), false);
  } finally {
    repo.cleanup();
  }
});
