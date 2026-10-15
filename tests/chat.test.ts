import { createServer } from 'node:http';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cliPath = path.join(projectRoot, 'src', 'index.ts');

test('interactive chat sends safe repository context and preserves conversation history', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-chat-test-'));
  const secretSentinel = 'CHAT_TEST_SECRET_MUST_NEVER_BE_SENT';

  let child: ReturnType<typeof spawn> | undefined;
  let serverAddress: { port: number } | undefined;
  const requestBodies: Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];

  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });

    request.on('end', () => {
      requestBodies.push(JSON.parse(body) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      });

      response.writeHead(200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: 'Mock response successful',
          },
        }],
      }));
    });
  });

  let stdout = '';
  let stderr = '';

  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Dev Assistant Test'], {
      cwd: repo,
    });
    execFileSync('git', ['config', 'user.email', 'chat-test@example.invalid'], {
      cwd: repo,
    });

    writeFileSync(
      path.join(repo, 'README.md'),
      '# Chat integration fixture\nThis is a test repository.\n',
    );
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'chat-integration-fixture' }, null, 2) + '\n',
    );
    writeFileSync(
      path.join(repo, '.env.local'),
      `PRIVATE_VALUE=${secretSentinel}\n`,
    );

    execFileSync('git', ['add', 'README.md', 'package.json'], {
      cwd: repo,
    });
    execFileSync('git', ['commit', '-m', 'test: create chat fixture'], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Dev Assistant Test',
        GIT_AUTHOR_EMAIL: 'chat-test@example.invalid',
        GIT_COMMITTER_NAME: 'Dev Assistant Test',
        GIT_COMMITTER_EMAIL: 'chat-test@example.invalid',
      },
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    serverAddress = { port: address.port };

    child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cliPath, 'chat'],
      {
        cwd: repo,
        env: {
          ...process.env,
          AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          AI_API_KEY: 'test-only-key',
          AI_MODEL: 'test-provider/chat-model',
          OPENROUTER_API_KEY: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    function waitForOutput(
      predicate: (output: string) => boolean,
    ): Promise<void> {
      return new Promise((resolve, reject) => {
        const onData = () => {
          if (predicate(stdout)) {
            cleanup();
            resolve();
          }
        };

        const onClose = (code: number | null) => {
          cleanup();
          reject(new Error(
            `Chat exited before expected output (code ${code}).\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`,
          ));
        };

        const cleanup = () => {
          child?.stdout.off('data', onData);
          child?.off('close', onClose);
        };

        child?.stdout.on('data', onData);
        child?.once('close', onClose);
        onData();
      });
    }

    await waitForOutput((output) => output.includes('You> '));
    child.stdin.write('Explain this repository.\n');

    await waitForOutput(
      (output) => output.includes('AI> Mock response successful'),
    );
    child.stdin.write('Which files are tracked?\n');

    await waitForOutput(
      (output) =>
        (output.match(/AI> Mock response successful/g) || []).length >= 2,
    );
    child.stdin.write('/exit\n');

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child?.once('error', reject);
      child?.once('close', resolve);
    });

    assert.equal(exitCode, 0, stderr);
    assert.equal(requestBodies.length, 2);

    const firstRequest = requestBodies[0];
    const secondRequest = requestBodies[1];

    assert.ok(firstRequest);
    assert.ok(secondRequest);

    assert.equal(firstRequest.model, 'test-provider/chat-model');
    assert.equal(secondRequest.model, 'test-provider/chat-model');

    const firstPayload = JSON.stringify(firstRequest.messages);
    const secondPayload = JSON.stringify(secondRequest.messages);

    assert.match(firstPayload, /REPOSITORY CONTEXT/);
    assert.match(firstPayload, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(firstPayload, /README\.md/);
    assert.match(firstPayload, /package\.json/);
    assert.match(firstPayload, /test repository/);

    assert.match(secondPayload, /REPOSITORY CONTEXT/);
    assert.match(secondPayload, /Explain this repository\./);
    assert.match(secondPayload, /Which files are tracked\?/);
    assert.match(secondPayload, /Mock response successful/);

    assert.doesNotMatch(firstPayload, new RegExp(secretSentinel));
    assert.doesNotMatch(secondPayload, new RegExp(secretSentinel));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }

    if (serverAddress) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    rmSync(repo, { recursive: true, force: true });
  }
});
