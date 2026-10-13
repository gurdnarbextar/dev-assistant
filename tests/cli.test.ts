import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'src', 'index.ts');

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, ...args],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
}

test('help displays available commands', () => {
  const result = runCli('help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /git-status/);
  assert.match(result.stdout, /ai-debug/);
  assert.match(result.stdout, /doctor/);
});

test('version displays the CLI version', () => {
  const result = runCli('version');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dev Assistant v0\.1\.0/);
});

test('unknown commands return a non-zero exit code', () => {
  const result = runCli('not-a-real-command');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});

test('AI configuration does not print API key values', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, 'ai-config'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        AI_API_KEY: 'test-secret-value',
        AI_MODEL: 'test-model',
      },
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /configured \(value hidden\)/);
  assert.doesNotMatch(result.stdout, /test-secret-value/);
});

function runCliWithEnv(args: string[], overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, ...args],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, ...overrides },
    },
  );
}

test('AI model listing displays configured aliases', () => {
  const result = runCliWithEnv(['ai-models'], {
    OPENROUTER_OPENAI_MINI_MODEL: 'test-provider/test-mini-model',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /openai-mini\s+test-provider\/test-mini-model/);
  assert.match(result.stdout, /deepseek-vision/);
  assert.doesNotMatch(result.stdout, /test-secret-value/);
});

test('AI ask rejects unknown model aliases without making a request', () => {
  const result = runCliWithEnv(
    ['ai-ask', '--model', 'not-a-real-model', 'test prompt'],
    {
      AI_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown model alias: not-a-real-model/);
  assert.doesNotMatch(result.stderr, /test-secret-value/);
});

test('AI ask rejects --model without a value', () => {
  const result = runCliWithEnv(['ai-ask', '--model'], {
    AI_API_KEY: '',
    OPENROUTER_API_KEY: '',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: --model <alias-or-provider\/model-id>/);
});
