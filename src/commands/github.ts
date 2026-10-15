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
