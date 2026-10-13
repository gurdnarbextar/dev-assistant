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
    console.error(`GitHub CLI error: ${result.error.message}`);
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
  });

  if (version.status !== 0) {
    console.error('GitHub CLI (gh) is not installed or is unavailable.');
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
