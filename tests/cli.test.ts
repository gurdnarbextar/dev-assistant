import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
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

test('AI ask sends the selected alias model to the provider', async () => {
  let requestBody = '';
  const tsxLoader = import.meta.resolve('tsx');

  const server = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      requestBody += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: 'Mock response successful' } }],
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const tsxLoader = import.meta.resolve('tsx');
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import', 'tsx', cliPath,
          'ai-ask', '--model', 'openai-mini', 'Say hello',
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            AI_API_KEY: 'test-only-key',
            AI_MODEL: 'test-provider/default-model',
            OPENROUTER_API_KEY: '',
            OPENROUTER_OPENAI_MINI_MODEL: 'test-provider/test-mini-model',
          },
        },
      );

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Mock response successful/);

    const payload = JSON.parse(requestBody) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };

    assert.equal(payload.model, 'test-provider/test-mini-model');
    assert.deepEqual(payload.messages, [
      { role: 'user', content: 'Say hello' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('AI provider errors do not expose response details or API keys', async () => {
  const sensitiveDetail = 'sensitive-provider-detail-test-sentinel';
  const testApiKey = 'test-only-api-key-sentinel';

  const server = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      error: { message: sensitiveDetail },
      diagnostic: sensitiveDetail,
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', cliPath, 'ai-ask', 'test prompt'],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            AI_API_KEY: testApiKey,
            AI_MODEL: 'test-provider/test-model',
            OPENROUTER_API_KEY: '',
          },
        },
      );

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /HTTP 401/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sensitiveDetail));
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(testApiKey));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});


async function runAICommandWithMockProvider(
  commandArgs: string[],
  cwd: string,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  model: string;
  prompt: string;
}> {
  let requestBody = '';

  const server = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      requestBody += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: 'Mock response successful' } }],
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const tsxLoader = import.meta.resolve('tsx');
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', tsxLoader, cliPath, ...commandArgs],
        {
          cwd,
          env: {
            ...process.env,
            AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            AI_API_KEY: 'test-only-key',
            AI_MODEL: 'test-provider/default-model',
            OPENROUTER_API_KEY: '',
            OPENROUTER_OPENAI_MINI_MODEL: 'test-provider/test-mini-model',
          },
        },
      );

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });

    if (!requestBody) {
      throw new Error(
        `Mock provider received no request. Exit code: ${result.code}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    const payload = JSON.parse(requestBody) as {
      model: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    const prompt = (payload.messages ?? [])
      .map((message) => message.content ?? '')
      .join('\n');
    return { ...result, model: payload.model, prompt };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('AI debug forwards the selected model to the provider', async () => {
  const result = await runAICommandWithMockProvider(
    ['ai-debug', '--model', 'openai-mini', 'test failure description'],
    projectRoot,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Mock response successful/);
  assert.equal(result.model, 'test-provider/test-mini-model');
});

test('AI debug includes validation output and evidence constraints in the provider prompt', async () => {
  const result = await runAICommandWithMockProvider(
    ['ai-debug', 'Investigate the current project state', '--check', 'typecheck'],
    projectRoot,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Diagnostic check passed: typecheck/);
  assert.match(result.prompt, /Check: npm run typecheck/);
  assert.match(result.prompt, /Exit status: 0/);
  assert.match(result.prompt, /Result: passed/);
  assert.match(result.prompt, /Separate confirmed facts, hypotheses, and unknowns/);
  assert.match(result.prompt, /Do not invent repository files, test suites/);
  assert.match(result.prompt, /If evidence is insufficient/);
  assert.doesNotMatch(result.prompt, /test-only-key/);
});

test('AI debug rejects a check that the project does not define', async () => {
  const result = runCliWithEnv(
    ['ai-debug', 'Investigate this failure', '--check', 'lint'],
    {
      AI_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not define an npm script named "lint"/);
  assert.doesNotMatch(result.stderr, /API key/i);
});

test('AI debug rejects an unsupported check name', async () => {
  const result = runCliWithEnv(
    ['ai-debug', 'Investigate this failure', '--check', 'deploy'],
    {
      AI_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: dev-assistant ai-debug/);
});

test('AI review forwards the selected model to the provider', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-review-test-'));

  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Dev Assistant Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'dev-assistant-test@example.invalid'], {
      cwd: repo,
    });

    writeFileSync(path.join(repo, 'sample.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'sample.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test fixture'],
      { cwd: repo, stdio: 'ignore' },
    );
    writeFileSync(path.join(repo, 'sample.ts'), 'export const value = 2;\n');

    const result = await runAICommandWithMockProvider(
      ['ai-review', '--model', 'openai-mini', '--send'],
      repo,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Mock response successful/);
    assert.equal(result.model, 'test-provider/test-mini-model');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
