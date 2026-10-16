import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const cliPath = path.join(projectRoot, 'src', 'index.ts');
const tsxLoader = import.meta.resolve('tsx');

function createFixture(
  scripts: Record<string, string> = {
    typecheck: 'node -e "process.exit(0)"',
    test: 'node -e "process.exit(0)"',
  },
): string {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'dev-assistant-automation-'),
  );

  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'automation-fixture',
        version: '1.0.0',
        scripts,
      },
      null,
      2,
    ),
  );

  execFileSync('git', ['init', '-b', 'automation/test'], {
    cwd: root,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Automation Test'], {
    cwd: root,
  });
  execFileSync(
    'git',
    ['config', 'user.email', 'automation-test@example.invalid'],
    { cwd: root },
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'test fixture'], {
    cwd: root,
    stdio: 'ignore',
  });

  return root;
}

function isolatedEnv(root: string): Record<string, string> {
  const envRoot = path.join(root, '.test-env');

  return {
    HOME: envRoot,
    XDG_CONFIG_HOME: path.join(envRoot, 'config'),
    XDG_STATE_HOME: path.join(envRoot, 'state'),
  };
}

function runCli(
  cwd: string,
  args: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--import', tsxLoader, cliPath, 'automation', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        ...isolatedEnv(cwd),
      },
    },
  );
}

function automationStateRoot(root: string): string {
  const stateHome = isolatedEnv(root).XDG_STATE_HOME;
  const projectHash = execFileSync(
    'git',
    ['rev-parse', '--show-toplevel'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim();

  const hash = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
        import { createHash } from 'node:crypto';
        process.stdout.write(
          createHash('sha256').update(process.argv[1]).digest('hex').slice(0, 16)
        );
      `,
      projectHash,
    ],
    { encoding: 'utf8' },
  ).trim();

  return path.join(stateHome, 'dev-assistant', hash);
}

test('automation init creates persistent configuration', () => {
  const root = createFixture();

  try {
    const result = runCli(root, ['init']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Automation configuration initialized/i);
    assert.match(result.stdout, /Automatic commits: disabled/i);
    assert.match(result.stdout, /Automatic pushes: disabled/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation config displays configured checks and safety defaults', () => {
  const root = createFixture();

  try {
    const init = runCli(root, ['init']);
    assert.equal(init.status, 0, init.stderr);

    const result = runCli(root, ['config']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /typecheck/i);
    assert.match(result.stdout, /test/i);
    assert.match(result.stdout, /Automatic commits:\s+disabled/i);
    assert.match(result.stdout, /Automatic pushes:\s+disabled/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation run executes available checks and records a report', () => {
  const root = createFixture();

  try {
    const init = runCli(root, ['init']);
    assert.equal(init.status, 0, init.stderr);

    const result = runCli(root, ['run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Automation run .*: passed/i);
    assert.match(result.stdout, /Report:/i);

    const stateRoot = automationStateRoot(root);
    const historyPath = path.join(stateRoot, 'history.jsonl');
    const reportsDir = path.join(stateRoot, 'reports');

    assert.equal(existsSync(historyPath), true);
    assert.equal(existsSync(reportsDir), true);

    const history = readFileSync(historyPath, 'utf8').trim();
    assert.notEqual(history, '');

    const reports = readdirSync(reportsDir)
      .filter((file: string) => file.endsWith('.md'));

    assert.equal(reports.length, 1);

    const report = readFileSync(
      path.join(reportsDir, reports[0]),
      'utf8',
    );

    assert.match(report, /Automation Run/i);
    assert.match(report, /passed/i);
    assert.match(report, /typecheck/i);
    assert.match(report, /test/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation run records failed checks and exits non-zero', () => {
  const root = createFixture({
    test: 'node -e "process.exit(1)"',
  });

  try {
    const init = runCli(root, ['init']);
    assert.equal(init.status, 0, init.stderr);

    const result = runCli(root, ['run']);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Automation run .*: failed/i);
    assert.match(result.stdout, /Findings:/i);
    assert.match(result.stdout, /test/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation history reports completed runs', () => {
  const root = createFixture();

  try {
    assert.equal(runCli(root, ['init']).status, 0);
    const run = runCli(root, ['run']);
    assert.equal(run.status, 0, run.stderr);

    const result = runCli(root, ['history']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed/i);
    assert.match(result.stdout, /automation/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation status reports configuration and run state', () => {
  const root = createFixture();

  try {
    assert.equal(runCli(root, ['init']).status, 0);
    assert.equal(runCli(root, ['run']).status, 0);

    const result = runCli(root, ['status']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Automation/i);
    assert.match(result.stdout, /interval/i);
    assert.match(result.stdout, /last run/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation refuses a live lock instead of running concurrently', () => {
  const root = createFixture();

  try {
    assert.equal(runCli(root, ['init']).status, 0);

    const stateRoot = automationStateRoot(root);
    mkdirSync(stateRoot, { recursive: true });

    writeFileSync(
      path.join(stateRoot, 'run.lock'),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );

    const result = runCli(root, ['run']);

    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /already locked|already running/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation detects tracked secrets without exposing the secret value', () => {
  const root = createFixture({
    test: 'node -e "process.exit(0)"',
  });

  const secret = 'sk-test-automation-secret-sentinel';

  try {
    writeFileSync(
      path.join(root, 'config.js'),
      `const token = "${secret}";\n`,
    );

    execFileSync('git', ['add', 'config.js'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'add test secret'], {
      cwd: root,
      stdio: 'ignore',
    });

    assert.equal(runCli(root, ['init']).status, 0);

    const result = runCli(root, ['run']);

    assert.equal(result.status, 1);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.match(output, /secret|credential|token/i);
    assert.doesNotMatch(output, /sk-test-automation-secret-sentinel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation does not commit staged changes by default', () => {
  const root = createFixture();

  try {
    writeFileSync(path.join(root, 'uncommitted.txt'), 'automation test\n');
    execFileSync('git', ['add', 'uncommitted.txt'], { cwd: root });

    assert.equal(runCli(root, ['init']).status, 0);

    const result = runCli(root, ['run']);

    assert.equal(result.status, 0, result.stderr);

    const status = execFileSync(
      'git',
      ['status', '--porcelain'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    assert.match(status, /A\s+uncommitted\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown automation actions return a non-zero exit code', () => {
  const root = createFixture();

  try {
    const result = runCli(root, ['not-a-real-action']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown automation action/i);
    assert.match(
      result.stderr,
      /dev-assistant automation <init\|status\|config\|history\|run\|daemon>/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
