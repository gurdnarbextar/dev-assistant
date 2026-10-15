import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { isGitRepository } from '../lib/git.js';

function runGh(args: string[]): boolean {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 30_000,
  });

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      console.error('GitHub CLI (gh) is not installed or is not available on PATH.');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('GitHub CLI command timed out after 30 seconds.');
    } else {
      console.error(`GitHub CLI could not be executed: ${error.message}`);
    }

    process.exitCode = 1;
    return false;
  }

  if (result.status === null) {
    console.error(
      result.signal
        ? `GitHub CLI was terminated by signal ${result.signal}.`
        : 'GitHub CLI did not return an exit status.',
    );
    process.exitCode = 1;
    return false;
  }

  if (result.status !== 0) {
    console.error(`GitHub CLI exited with status ${result.status}.`);
    process.exitCode = 1;
    return false;
  }

  return true;
}

function requireRepository(): boolean {
  if (isGitRepository()) return true;
  console.error('Run this command from inside a Git repository.');
  process.exitCode = 1;
  return false;
}

export function githubDoctor(): void {
  const version = spawnSync('gh', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  });

  if (version.error || version.status !== 0) {
    const error = version.error as NodeJS.ErrnoException | undefined;

    if (error?.code === 'ETIMEDOUT') {
      console.error('GitHub CLI version check timed out after 10 seconds.');
    } else {
      console.error('GitHub CLI (gh) is not installed or is unavailable.');
    }

    process.exitCode = 1;
    return;
  }

  console.log(version.stdout.trim().split('\n')[0]);
  console.log('\nChecking GitHub authentication...');
  runGh(['auth', 'status']);
}

export function githubRepo(): void {
  if (!requireRepository()) return;
  runGh(['repo', 'view']);
}

export function githubIssues(): void {
  if (!requireRepository()) return;
  const state = process.argv[3] ?? 'open';

  if (!['open', 'closed', 'all'].includes(state)) {
    console.error('Usage: dev-assistant gh-issues [open|closed|all]');
    process.exitCode = 1;
    return;
  }

  runGh(['issue', 'list', '--state', state, '--limit', '30']);
}

export function githubPrs(): void {
  if (!requireRepository()) return;
  const state = process.argv[3] ?? 'open';

  if (!['open', 'closed', 'merged', 'all'].includes(state)) {
    console.error('Usage: dev-assistant gh-prs [open|closed|merged|all]');
    process.exitCode = 1;
    return;
  }

  runGh(['pr', 'list', '--state', state, '--limit', '30']);
}

export function githubRuns(): void {
  if (!requireRepository()) return;
  runGh(['run', 'list', '--limit', '20']);
}


export function githubPrCreate(): void {
  if (!requireRepository()) return;

  const args = process.argv.slice(3);
  let title = '';
  let body = '';
  let base = '';
  let draft = false;
  const seen = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--draft') {
      if (seen.has(arg)) {
        console.error('Duplicate option: --draft');
        process.exitCode = 1;
        return;
      }
      seen.add(arg);
      draft = true;
      continue;
    }

    if (!['--title', '--body', '--base'].includes(arg)) {
      console.error(
        'Usage: dev-assistant gh-pr-create --title "Title" --body "Description" [--base branch] [--draft]',
      );
      process.exitCode = 1;
      return;
    }

    const nextArg = args[i + 1];
    if (seen.has(arg) || nextArg === undefined || nextArg.startsWith('--')) {
      console.error(`Missing value or duplicate option: ${arg}`);
      process.exitCode = 1;
      return;
    }

    seen.add(arg);
    i += 1;
    const value = nextArg.trim();

    if (!value) {
      console.error(`The value for ${arg} cannot be empty.`);
      process.exitCode = 1;
      return;
    }

    if (arg === '--title') title = value;
    if (arg === '--body') body = value;
    if (arg === '--base') base = value;
  }

  if (!title || !body) {
    console.error(
      'Usage: dev-assistant gh-pr-create --title "Title" --body "Description" [--base branch] [--draft]',
    );
    process.exitCode = 1;
    return;
  }

  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const branch = branchResult.stdout?.trim() ?? '';
  if (branchResult.status !== 0 || !branch) {
    console.error('Cannot determine the current branch. Ensure HEAD points to a local branch.');
    process.exitCode = 1;
    return;
  }

  if (branch === 'main' || branch === 'master') {
    console.error('Pull request creation is prohibited from main/master. Use a feature branch.');
    process.exitCode = 1;
    return;
  }

  const upstreamResult = spawnSync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );

  if (upstreamResult.status !== 0 || !upstreamResult.stdout?.trim()) {
    console.error('The current branch has no upstream. Push it and set its upstream before creating a pull request.');
    process.exitCode = 1;
    return;
  }

  const aheadResult = spawnSync('git', ['rev-list', '--count', '@{u}..HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const ahead = Number(aheadResult.stdout?.trim());
  if (aheadResult.status !== 0 || !Number.isInteger(ahead) || ahead < 1) {
    console.error('Cannot verify commits ahead of upstream. No pull request was created.');
    process.exitCode = 1;
    return;
  }

  const ghArgs = ['pr', 'create', '--title', title, '--body', body, '--head', branch];
  if (base) ghArgs.push('--base', base);
  if (draft) ghArgs.push('--draft');

  console.log(`Creating ${draft ? 'draft ' : ''}pull request from branch "${branch}"...`);
  runGh(ghArgs);
}
