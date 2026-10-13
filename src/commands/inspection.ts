import process from 'node:process';
import { runGit, requireGitRepository } from '../lib/git.js';

export function gitStatus(): void {
  if (!requireGitRepository()) return;
  console.log(`Repository: ${runGit(['rev-parse', '--show-toplevel'])}`);
  console.log(`Branch: ${runGit(['branch', '--show-current']) || '(detached HEAD)'}`);
  console.log('\nWorking tree:');
  console.log(runGit(['status', '--short', '--branch']) || 'Clean');
}

export function gitDiff(): void {
  if (!requireGitRepository()) return;
  const staged = process.argv.includes('--staged');
  const args = staged
    ? ['diff', '--cached', '--no-ext-diff', '--']
    : ['diff', '--no-ext-diff', '--'];
  console.log(runGit(args) || `No ${staged ? 'staged' : 'unstaged'} tracked changes.`);
}

export function gitSummary(): void {
  if (!requireGitRepository()) return;
  console.log(`Repository: ${runGit(['rev-parse', '--show-toplevel'])}`);
  console.log(`Branch: ${runGit(['branch', '--show-current']) || '(detached HEAD)'}`);
  console.log(`\nChanges:\n${runGit(['status', '--short']) || 'Working tree clean.'}`);
  console.log(`\nUnstaged:\n${runGit(['diff', '--stat']) || 'None.'}`);
  console.log(`\nStaged:\n${runGit(['diff', '--cached', '--stat']) || 'None.'}`);
}

export function gitLog(): void {
  if (!requireGitRepository()) return;
  const countArg = process.argv[3];
  const count = countArg && /^\d+$/.test(countArg)
    ? Math.min(Math.max(Number(countArg), 1), 100)
    : 10;
  console.log(runGit([
    'log', `-${count}`, '--date=short',
    '--pretty=format:%h  %ad  %an  %s',
  ]) || 'No commits yet.');
  console.log();
}

export function gitBranches(): void {
  if (!requireGitRepository()) return;
  console.log(runGit(['branch', '-vv']) || 'No local branches.');
}

export function gitCheck(): void {
  if (!requireGitRepository()) return;
  console.log('Checking repository object integrity...');
  console.log(runGit(['fsck', '--full', '--no-reflogs']));
  console.log('\nChecking whitespace errors in unstaged changes...');
  console.log(runGit(['diff', '--check']) || 'No whitespace errors found.');
  console.log('\nChecking whitespace errors in staged changes...');
  console.log(runGit(['diff', '--cached', '--check']) || 'No staged whitespace errors found.');
}
