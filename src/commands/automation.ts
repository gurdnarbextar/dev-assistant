import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';
import { runGit, requireGitRepository } from '../lib/git.js';

type CheckName = 'typecheck' | 'lint' | 'build' | 'test';

interface AutomationConfig {
  intervalMinutes: number;
  checks: CheckName[];
  autoCommitStaged: boolean;
  autoPush: boolean;
  pushBranches: string[];
  commitMessage: string;
}

interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed' | 'skipped';
  branch: string;
  findings: string[];
  reportPath: string;
}

interface Paths {
  root: string;
  configDir: string;
  stateDir: string;
  config: string;
  history: string;
  lock: string;
  reports: string;
}

interface GitSnapshot {
  branch: string;
  status: string;
  upstream: string;
  divergence: string;
  diffCheck: string;
}

interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_CONFIG: AutomationConfig = {
  intervalMinutes: 60,
  checks: ['typecheck', 'lint', 'build', 'test'],
  autoCommitStaged: false,
  autoPush: false,
  pushBranches: [],
  commitMessage: 'chore: automated maintenance',
};

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'private key material',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    name: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  },
  {
    name: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/,
  },
  {
    name: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    name: 'Stripe live secret',
    pattern: /\brk_live_[A-Za-z0-9]{16,}\b/,
  },
  {
    name: 'OpenAI-style API key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
];

const MAX_TRACKED_FILES = 5000;
const MAX_SCAN_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

function findGitRoot(): string {
  try {
    return runGit(['rev-parse', '--show-toplevel']);
  } catch {
    fail('Automation commands must be run inside a Git repository.');
  }
}

function getPaths(root: string): Paths {
  const projectId = createHash('sha256')
    .update(root)
    .digest('hex')
    .slice(0, 32);

  const configBase =
    process.env.XDG_CONFIG_HOME?.trim() ||
    join(process.env.HOME || root, '.config');

  const stateBase =
    process.env.XDG_STATE_HOME?.trim() ||
    join(process.env.HOME || root, '.local', 'state');

  const configDir = join(configBase, 'dev-assistant', projectId);
  const stateDir = join(stateBase, 'dev-assistant', projectId);

  return {
    root,
    configDir,
    stateDir,
    config: join(configDir, 'automation.json'),
    history: join(stateDir, 'history.jsonl'),
    lock: join(stateDir, 'run.lock'),
    reports: join(stateDir, 'reports'),
  };
}

function ensureSecureDir(path: string): void {
  mkdirSync(path, {
    recursive: true,
    mode: 0o700,
  });
}

function ensurePaths(paths: Paths): void {
  ensureSecureDir(paths.configDir);
  ensureSecureDir(paths.stateDir);
  ensureSecureDir(paths.reports);
}

function atomicWrite(path: string, content: string): void {
  ensureSecureDir(dirname(path));

  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;

  writeFileSync(temporary, content, {
    encoding: 'utf8',
    mode: 0o600,
  });

  renameSync(temporary, path);
}

function normaliseChecks(value: unknown): CheckName[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_CONFIG.checks];
  }

  const valid = new Set<CheckName>([
    'typecheck',
    'lint',
    'build',
    'test',
  ]);

  const checks = value.filter(
    (item): item is CheckName =>
      typeof item === 'string' && valid.has(item as CheckName),
  );

  return checks.length > 0
    ? [...new Set(checks)]
    : [...DEFAULT_CONFIG.checks];
}

function loadConfig(paths: Paths): AutomationConfig {
  if (!existsSync(paths.config)) {
    return {
      ...DEFAULT_CONFIG,
      checks: [...DEFAULT_CONFIG.checks],
      pushBranches: [],
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(paths.config, 'utf8'));
  } catch {
    fail(`Invalid automation configuration: ${paths.config}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    fail('Automation configuration must be a JSON object.');
  }

  const value = parsed as Record<string, unknown>;

  const intervalMinutes =
    typeof value.intervalMinutes === 'number' &&
    Number.isFinite(value.intervalMinutes) &&
    value.intervalMinutes >= 1
      ? Math.floor(value.intervalMinutes)
      : DEFAULT_CONFIG.intervalMinutes;

  const pushBranches = Array.isArray(value.pushBranches)
    ? value.pushBranches.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    : [];

  return {
    intervalMinutes,
    checks: normaliseChecks(value.checks),
    autoCommitStaged: value.autoCommitStaged === true,
    autoPush: value.autoPush === true,
    pushBranches,
    commitMessage:
      typeof value.commitMessage === 'string' &&
      value.commitMessage.trim().length > 0
        ? value.commitMessage.trim()
        : DEFAULT_CONFIG.commitMessage,
  };
}

function saveConfig(
  paths: Paths,
  config: AutomationConfig,
): void {
  ensurePaths(paths);
  atomicWrite(
    paths.config,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
    },
    maxBuffer: MAX_COMMAND_OUTPUT,
    timeout: timeoutMs,
  });

  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function packageManager(
  root: string,
): { command: string; prefix: string[] } {
  const packagePath = join(root, 'package.json');
  let packageManagerField: string | undefined;

  if (existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(
        readFileSync(packagePath, 'utf8'),
      ) as {
        packageManager?: unknown;
      };

      if (typeof packageJson.packageManager === 'string') {
        packageManagerField = packageJson.packageManager;
      }
    } catch {
      // Project checks will expose package.json problems.
    }
  }

  const fieldName = packageManagerField?.split('@')[0];

  if (fieldName === 'pnpm') {
    return { command: 'pnpm', prefix: ['run'] };
  }

  if (fieldName === 'yarn') {
    return { command: 'yarn', prefix: [] };
  }

  if (fieldName === 'bun') {
    return { command: 'bun', prefix: ['run'] };
  }

  if (fieldName === 'npm') {
    return { command: 'npm', prefix: ['run'] };
  }

  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return { command: 'pnpm', prefix: ['run'] };
  }

  if (existsSync(join(root, 'yarn.lock'))) {
    return { command: 'yarn', prefix: [] };
  }

  if (
    existsSync(join(root, 'bun.lockb')) ||
    existsSync(join(root, 'bun.lock'))
  ) {
    return { command: 'bun', prefix: ['run'] };
  }

  return { command: 'npm', prefix: ['run'] };
}

function projectScripts(root: string): Record<string, unknown> {
  const path = join(root, 'package.json');

  if (!existsSync(path)) {
    return {};
  }

  try {
    const packageJson = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as {
      scripts?: unknown;
    };

    return packageJson.scripts &&
      typeof packageJson.scripts === 'object'
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function runConfiguredChecks(
  root: string,
  checks: CheckName[],
  findings: string[],
): string[] {
  const scripts = projectScripts(root);
  const manager = packageManager(root);
  const executed: string[] = [];

  for (const check of checks) {
    if (!(check in scripts)) {
      continue;
    }

    const result = runCommand(
      manager.command,
      [...manager.prefix, check],
      root,
    );

    executed.push(check);

    if (result.timedOut) {
      findings.push(
        `${check}: command timed out after ${COMMAND_TIMEOUT_MS / 60000} minutes.`,
      );
      continue;
    }

    if (result.status !== 0) {
      const diagnostic =
        (result.stderr || result.stdout)
          .trim()
          .split('\n')[0]
          ?.slice(0, 240) ||
        'command failed without diagnostic output';

      findings.push(`${check}: failed (${diagnostic})`);
    }
  }

  return executed;
}

function gitSnapshot(root: string): GitSnapshot {
  const branch =
    runGit(['branch', '--show-current'], root) ||
    '(detached HEAD)';

  const status = runGit(['status', '--short'], root);

  let upstream = '';

  try {
    upstream = runGit(
      [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{u}',
      ],
      root,
    );
  } catch {
    upstream = '(none)';
  }

  let divergence = '';

  if (upstream !== '(none)') {
    try {
      divergence = runGit(
        ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
        root,
      );
    } catch {
      divergence = '(unavailable)';
    }
  } else {
    divergence = '(no upstream)';
  }

  let diffCheck = '';

  try {
    runGit(['diff', '--check'], root);
    runGit(['diff', '--cached', '--check'], root);
    diffCheck = 'PASS';
  } catch (error) {
    diffCheck =
      error instanceof Error
        ? error.message.split('\n')[0] || 'failed'
        : 'failed';
  }

  return {
    branch,
    status,
    upstream,
    divergence,
    diffCheck,
  };
}

function trackedFiles(root: string): string[] {
  try {
    return runGit(['ls-files', '-z'], root)
      .split('\0')
      .filter(Boolean)
      .slice(0, MAX_TRACKED_FILES);
  } catch {
    return [];
  }
}

function isBinaryExtension(path: string): boolean {
  const extension =
    path.toLowerCase().split('.').pop() || '';

  return new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'ico',
    'pdf',
    'zip',
    'gz',
    'tar',
    '7z',
    'mp3',
    'mp4',
    'mov',
    'avi',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'exe',
    'dll',
    'so',
    'dylib',
    'bin',
    'class',
    'pyc',
    'o',
    'a',
  ]).has(extension);
}

function scanTrackedSecrets(
  root: string,
  findings: string[],
): void {
  for (const file of trackedFiles(root)) {
    if (
      file.startsWith('.git/') ||
      file.includes('/node_modules/') ||
      file.includes('/dist/') ||
      file.includes('/build/') ||
      file.includes('/coverage/') ||
      file.includes('/.next/') ||
      file === '.env' ||
      file.startsWith('.env.')
    ) {
      continue;
    }

    if (isBinaryExtension(file)) {
      continue;
    }

    const absolute = resolve(root, file);
    const relativePath = relative(root, absolute);

    if (
      relativePath.startsWith('..') ||
      relativePath.includes('/../')
    ) {
      continue;
    }

    try {
      const info = statSync(absolute);

      if (info.size > MAX_SCAN_BYTES) {
        continue;
      }

      const content = readFileSync(absolute);

      if (content.includes(0)) {
        continue;
      }

      const text = content.toString('utf8');

      for (const detector of SECRET_PATTERNS) {
        if (detector.pattern.test(text)) {
          findings.push(
            `security: possible ${detector.name} detected in tracked file ${file} (credential value suppressed)`,
          );
        }

        detector.pattern.lastIndex = 0;
      }
    } catch {
      // Unreadable files are skipped.
    }
  }
}

function acquireLock(paths: Paths): () => void {
  ensurePaths(paths);

  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  let fd: number | undefined;

  try {
    fd = openSync(paths.lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  if (fd === undefined) {
    let existingPid: number | undefined;

    try {
      const existing = JSON.parse(
        readFileSync(paths.lock, 'utf8'),
      ) as {
        pid?: unknown;
      };

      if (typeof existing.pid === 'number') {
        existingPid = existing.pid;
      }
    } catch {
      existingPid = undefined;
    }

    if (existingPid !== undefined) {
      try {
        process.kill(existingPid, 0);
        fail(
          `Automation run is already locked by process ${existingPid}.`,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === 'EPERM') {
          fail(
            `Automation run is locked by process ${existingPid}.`,
          );
        }

        if (code !== 'ESRCH') {
          throw error;
        }
      }
    }

    unlinkSync(paths.lock);

    try {
      fd = openSync(paths.lock, 'wx', 0o600);
    } catch {
      fail('Unable to acquire the automation lock.');
    }
  }

  if (fd === undefined) {
    fail('Unable to acquire the automation lock.');
  }

  writeFileSync(fd, payload, 'utf8');
  closeSync(fd);

  return () => {
    try {
      unlinkSync(paths.lock);
    } catch {
      // Lock may have been recovered by another process.
    }
  };
}

function appendHistory(
  paths: Paths,
  record: RunRecord,
): void {
  ensurePaths(paths);

  appendFileSync(
    paths.history,
    `${JSON.stringify(record)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}

function writeReport(
  paths: Paths,
  record: RunRecord,
  snapshot: GitSnapshot,
  executedChecks: string[],
): string {
  ensurePaths(paths);

  const reportPath = join(
    paths.reports,
    `${record.id}.md`,
  );

  const findings =
    record.findings.length > 0
      ? record.findings
          .map((finding) => `- ${finding}`)
          .join('\n')
      : '- None';

  const report = [
    `# Automation Run ${record.id}`,
    '',
    `- Status: ${record.status}`,
    `- Started: ${record.startedAt}`,
    `- Finished: ${record.finishedAt}`,
    `- Branch: ${record.branch}`,
    '',
    '## Git snapshot',
    '',
    `- Working tree: ${snapshot.status ? 'changes present' : 'clean'}`,
    `- Upstream: ${snapshot.upstream}`,
    `- Divergence: ${snapshot.divergence}`,
    `- Diff check: ${snapshot.diffCheck}`,
    '',
    '## Checks',
    '',
    executedChecks.length > 0
      ? executedChecks
          .map((check) => `- ${check}: executed`)
          .join('\n')
      : '- No configured checks were available in package scripts.',
    '',
    '## Findings',
    '',
    findings,
    '',
    'Raw command output was intentionally omitted from the report.',
    '',
  ].join('\n');

  atomicWrite(reportPath, report);

  return reportPath;
}

function stagedChangesExist(root: string): boolean {
  const result = runCommand(
    'git',
    ['diff', '--cached', '--quiet'],
    root,
  );

  return result.status !== 0;
}

function commitStaged(
  root: string,
  message: string,
  findings: string[],
): boolean {
  if (!stagedChangesExist(root)) {
    return false;
  }

  const result = runCommand(
    'git',
    ['commit', '-m', message],
    root,
  );

  if (result.status !== 0) {
    findings.push(
      'commit: automatic commit failed; staged files were left untouched',
    );
    return false;
  }

  return true;
}

function pushIfAllowed(
  root: string,
  config: AutomationConfig,
  snapshot: GitSnapshot,
  findings: string[],
): boolean {
  if (!config.autoPush) {
    return false;
  }

  if (!config.pushBranches.includes(snapshot.branch)) {
    return false;
  }

  if (snapshot.upstream === '(none)') {
    findings.push(
      'push: skipped because the current branch has no upstream',
    );
    return false;
  }

  const status = runGit(
    ['status', '--porcelain'],
    root,
  );

  if (status) {
    findings.push(
      'push: skipped because the working tree is not clean',
    );
    return false;
  }

  const result = runCommand(
    'git',
    ['push'],
    root,
  );

  if (result.status !== 0) {
    findings.push('push: automatic push failed');
    return false;
  }

  return true;
}

function runAutomation(
  paths: Paths,
  config: AutomationConfig,
): RunRecord {
  const release = acquireLock(paths);

  const id = `${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

  const startedAt = new Date().toISOString();
  const findings: string[] = [];

  let snapshot: GitSnapshot = {
    branch: '(unknown)',
    status: '',
    upstream: '(unknown)',
    divergence: '(unknown)',
    diffCheck: '(not run)',
  };

  let executedChecks: string[] = [];

  try {
    snapshot = gitSnapshot(paths.root);

    if (snapshot.diffCheck !== 'PASS') {
      findings.push(
        `git: diff --check failed (${snapshot.diffCheck})`,
      );
    }

    scanTrackedSecrets(paths.root, findings);

    executedChecks = runConfiguredChecks(
      paths.root,
      config.checks,
      findings,
    );

    if (
      findings.length === 0 &&
      config.autoCommitStaged
    ) {
      commitStaged(
        paths.root,
        config.commitMessage,
        findings,
      );
    }

    if (findings.length === 0) {
      pushIfAllowed(
        paths.root,
        config,
        gitSnapshot(paths.root),
        findings,
      );
    }

    const status: RunRecord['status'] =
      findings.length === 0
        ? 'passed'
        : 'failed';

    const finishedAt = new Date().toISOString();

    const record: RunRecord = {
      id,
      startedAt,
      finishedAt,
      status,
      branch: snapshot.branch,
      findings,
      reportPath: '',
    };

    record.reportPath = writeReport(
      paths,
      record,
      snapshot,
      executedChecks,
    );

    appendHistory(paths, record);

    return record;
  } finally {
    release();
  }
}

function readHistory(
  paths: Paths,
): RunRecord[] {
  if (!existsSync(paths.history)) {
    return [];
  }

  return readFileSync(paths.history, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunRecord];
      } catch {
        return [];
      }
    });
}

function printConfig(
  paths: Paths,
  config: AutomationConfig,
): void {
  console.log(
    JSON.stringify(
      {
        ...config,
        configPath: paths.config,
        statePath: paths.stateDir,
      },
      null,
      2,
    ),
  );
}

function automationInit(): void {
  const root = findGitRoot();
  const paths = getPaths(root);

  ensurePaths(paths);

  if (!existsSync(paths.config)) {
    saveConfig(paths, {
      ...DEFAULT_CONFIG,
      checks: [...DEFAULT_CONFIG.checks],
      pushBranches: [],
    });

    console.log(
      `Automation configuration created: ${paths.config}`,
    );
  } else {
    console.log(
      `Automation configuration already exists: ${paths.config}`,
    );
  }

  console.log('Automatic commits: disabled');
  console.log('Automatic pushes: disabled');
}

function automationStatus(): void {
  const root = findGitRoot();
  const paths = getPaths(root);
  const config = loadConfig(paths);
  const history = readHistory(paths);

  let locked = false;

  if (existsSync(paths.lock)) {
    locked = true;

    try {
      const lock = JSON.parse(
        readFileSync(paths.lock, 'utf8'),
      ) as {
        pid?: unknown;
      };

      if (typeof lock.pid === 'number') {
        try {
          process.kill(lock.pid, 0);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code ===
            'ESRCH'
          ) {
            locked = false;
          }
        }
      }
    } catch {
      locked = true;
    }
  }

  console.log(`Repository: ${root}`);
  console.log(
    `Configuration: ${
      existsSync(paths.config)
        ? paths.config
        : 'not initialised'
    }`,
  );
  console.log(`State: ${paths.stateDir}`);
  console.log(
    `Interval: every ${config.intervalMinutes} minute(s)`,
  );
  console.log(
    `Checks: ${config.checks.join(', ')}`,
  );
  console.log(
    `Automatic commit: ${
      config.autoCommitStaged
        ? 'enabled'
        : 'disabled'
    }`,
  );
  console.log(
    `Automatic push: ${
      config.autoPush
        ? 'enabled'
        : 'disabled'
    }`,
  );
  console.log(
    `Run lock: ${locked ? 'held' : 'free'}`,
  );
  console.log(
    `Recorded runs: ${history.length}`,
  );
}

function automationHistory(): void {
  const root = findGitRoot();
  const paths = getPaths(root);
  const history = readHistory(paths);

  if (history.length === 0) {
    console.log(
      'No automation runs recorded.',
    );
    return;
  }

  for (
    const record of history.slice(-20).reverse()
  ) {
    console.log(
      `${record.finishedAt}  ${record.status.padEnd(7)}  ${record.branch}  ${record.id}`,
    );

    if (record.findings.length > 0) {
      for (const finding of record.findings) {
        console.log(`  - ${finding}`);
      }
    }

    console.log(
      `  report: ${record.reportPath}`,
    );
  }
}

function automationConfig(): void {
  const root = findGitRoot();
  const paths = getPaths(root);

  printConfig(
    paths,
    loadConfig(paths),
  );
}

function automationRun(): void {
  if (!requireGitRepository()) {
    return;
  }

  const root = findGitRoot();
  const paths = getPaths(root);
  const config = loadConfig(paths);

  const record = runAutomation(
    paths,
    config,
  );

  console.log(
    `Automation run ${record.id}: ${record.status}`,
  );

  console.log(
    `Report: ${record.reportPath}`,
  );

  if (record.findings.length > 0) {
    console.log('Findings:');

    for (const finding of record.findings) {
      console.log(`- ${finding}`);
    }

    process.exitCode = 1;
  }
}

async function automationDaemon(): Promise<void> {
  if (!requireGitRepository()) {
    return;
  }

  const root = findGitRoot();
  const paths = getPaths(root);
  const config = loadConfig(paths);

  const intervalMs =
    config.intervalMinutes * 60 * 1000;

  console.log(
    `Automation daemon started. Running every ${config.intervalMinutes} minute(s).`,
  );

  console.log(
    'The daemon runs only while this process is active. Press Ctrl+C to stop.',
  );

  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      const record = runAutomation(
        paths,
        config,
      );

      console.log(
        `${record.finishedAt} automation run: ${record.status}`,
      );
    } catch (error) {
      console.error(
        `Automation run failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    if (stopping) {
      break;
    }

    await new Promise<void>((resolvePromise) => {
      setTimeout(
        resolvePromise,
        intervalMs,
      );
    });
  }

  console.log(
    'Automation daemon stopped.',
  );
}

export async function automationCommand(): Promise<void> {
  const action = process.argv[3] ?? 'status';

  switch (action) {
    case 'init':
      automationInit();
      break;

    case 'status':
      automationStatus();
      break;

    case 'config':
      automationConfig();
      break;

    case 'history':
      automationHistory();
      break;

    case 'run':
      automationRun();
      break;

    case 'daemon':
      await automationDaemon();
      break;

    default:
      console.error(
        `Unknown automation action: ${action}`,
      );

      console.error(
        'Usage: dev-assistant automation <init|status|config|history|run|daemon>',
      );

      process.exitCode = 1;
  }
}
