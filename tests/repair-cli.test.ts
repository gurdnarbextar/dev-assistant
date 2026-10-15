import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cliPath = path.join(projectRoot, 'src', 'index.ts');
const tsxLoader = import.meta.resolve('tsx');

const patch = [
  'diff --git a/target.js b/target.js',
  '--- a/target.js',
  '+++ b/target.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n') + '\n';

function createFixture(branch = 'repair/test') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-repair-'));

  mkdirSync(root, { recursive: true });

  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'repair-fixture',
      version: '1.0.0',
      scripts: {
        typecheck: 'node check.cjs',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2),
  );

  writeFileSync(path.join(root, 'target.js'), 'old\n');
  writeFileSync(
    path.join(root, 'check.cjs'),
    [
      "const fs = require('node:fs');",
      "process.exit(fs.readFileSync('target.js', 'utf8').trim() === 'new' ? 0 : 1);",
      '',
    ].join('\n'),
  );

  execFileSync('git', ['init', '-b', branch], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Repair Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'repair-test@example.invalid'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: root });

  return root;
}

function runCli(
  cwd: string,
  args: string[],
  overrides: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, cliPath, 'ai-repair', ...args],
      {
        cwd,
        env: {
          ...process.env,
          AI_API_KEY: '',
          OPENROUTER_API_KEY: '',
          AI_MODEL: '',
          AI_BASE_URL: '',
          ...overrides,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI process timed out'));
    }, 30_000);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function withPatchServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: patch } }],
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

    await run(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('repair preview proposes a patch without modifying files', async () => {
  const root = createFixture();

  try {
    await withPatchServer(async (baseUrl) => {
      const result = await runCli(root, [], {
        AI_API_KEY: 'repair-test-key',
        AI_MODEL: 'test-model',
        AI_BASE_URL: baseUrl,
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /PROPOSED PATCH/);
      assert.match(result.stdout, /Preview only/);
      assert.equal(readFileSync(path.join(root, 'target.js'), 'utf8'), 'old\n');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair applies a valid patch and verifies the resulting checks', async () => {
  const root = createFixture();

  try {
    await withPatchServer(async (baseUrl) => {
      const result = await runCli(root, ['--apply'], {
        AI_API_KEY: 'repair-test-key',
        AI_MODEL: 'test-model',
        AI_BASE_URL: baseUrl,
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Patch applied/);
      assert.match(result.stdout, /Repair verified/);
      assert.equal(readFileSync(path.join(root, 'target.js'), 'utf8'), 'new\n');

      const status = spawnSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(status.status, 0);
      assert.match(status.stdout, /target\.js/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair refuses to apply changes on main', async () => {
  const root = createFixture('main');

  try {
    const result = await runCli(root, ['--apply']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /prohibited on main\/master/i);
    assert.equal(readFileSync(path.join(root, 'target.js'), 'utf8'), 'old\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair refuses to apply changes when the working tree is dirty', async () => {
  const root = createFixture();

  try {
    writeFileSync(path.join(root, 'target.js'), 'local work\n');

    const result = await runCli(root, ['--apply']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /clean working tree/i);
    assert.equal(readFileSync(path.join(root, 'target.js'), 'utf8'), 'local work\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair rejects an invalid max-attempts value before running checks', async () => {
  const root = createFixture();

  try {
    const result = await runCli(root, ['--max-attempts', '4']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Maximum attempts must be between 1 and 3/);
    assert.equal(readFileSync(path.join(root, 'target.js'), 'utf8'), 'old\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
