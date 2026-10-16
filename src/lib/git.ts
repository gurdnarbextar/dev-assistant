import { execFileSync, spawnSync } from 'node:child_process';

export function runGit(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

export function isGitRepository(cwd = process.cwd()): boolean {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function requireGitRepository(): boolean {
  if (isGitRepository()) return true;
  console.error('Error: current directory is not inside a Git repository.');
  return false;
}
