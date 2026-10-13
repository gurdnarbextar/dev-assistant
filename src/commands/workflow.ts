import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { runGit, requireGitRepository } from '../lib/git.js';

export function gitStage(): void {
  if (!requireGitRepository()) {
    process.exitCode = 1;
    return;
  }

  const files = process.argv.slice(3);

  if (files.length === 0) {
    console.error('Usage: dev-assistant git-stage <file> [file ...]');
    console.error('Specify files explicitly; this command does not stage everything automatically.');
    process.exitCode = 1;
    return;
  }

  if (files.some((file) => file.startsWith('-'))) {
    console.error('Options are not accepted as file paths.');
    process.exitCode = 1;
    return;
  }

  const result = spawnSync('git', ['add', '--', ...files], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  console.log('\nStaging completed. Review the result before committing.');
  console.log(runGit(['status', '--short']));
}

export function gitBranch(): void {
  if (!requireGitRepository()) {
    process.exitCode = 1;
    return;
  }

  const action = process.argv[3];
  const name = process.argv[4];

  if (action === undefined || action === 'list') {
    console.log(runGit(['branch', '-vv']) || 'No local branches.');
    return;
  }

  if (action !== 'create' || !name || name.startsWith('-')) {
    console.error('Usage: dev-assistant git-branch [list | create <branch-name>]');
    process.exitCode = 1;
    return;
  }

  const result = spawnSync('git', ['check-ref-format', '--branch', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    console.error('Invalid branch name.');
    process.exitCode = 1;
    return;
  }

  const created = spawnSync('git', ['branch', '--', name], {
    stdio: 'inherit',
  });

  if (created.status !== 0) {
    process.exitCode = created.status ?? 1;
    return;
  }

  console.log(`Created branch "${name}". Your current branch has not changed.`);
}
