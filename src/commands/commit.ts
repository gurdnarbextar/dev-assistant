import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { runGit, requireGitRepository } from '../lib/git.js';

export function gitCommit(): void {
  if (!requireGitRepository()) {
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(3).filter((arg) => arg !== '--confirm');
  const message = args.join(' ').trim();

  if (!message || message.startsWith('--')) {
    console.error('Usage: dev-assistant git-commit "Describe the change"');
    process.exitCode = 1;
    return;
  }

  const staged = runGit(['diff', '--cached', '--name-only']);
  if (!staged) {
    console.error('Nothing is staged. Review changes and stage files explicitly with git add first.');
    process.exitCode = 1;
    return;
  }

  console.log('Files staged for commit:\n');
  console.log(staged);
  console.log(`\nProposed commit message: ${message}`);
  console.log('\nNo commit has been created.');
  console.log('To confirm, run:');
  console.log(`git commit -m ${JSON.stringify(message)}`);

  if (process.argv.includes('--confirm')) {
    const result = spawnSync('git', ['commit', '-m', message], {
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
  } else {
    console.log('\nTo allow Dev Assistant to create this commit, add --confirm.');
  }
}

export function gitUndoHelp(): void {
  console.log(`
Git recovery guide (guidance only; no commands are executed)

1. Discard unstaged edits to a tracked file:
   git diff -- path/to/file
   Review first. "git restore path/to/file" discards those edits.

2. Unstage a file while preserving its edits:
   git restore --staged path/to/file

3. Correct the latest commit message:
   git commit --amend

4. Undo a published commit without rewriting shared history:
   git revert <commit-hash>

5. Inspect recent history before recovery:
   git log --oneline --decorate -10

Avoid "git reset --hard" and "git clean -fd" unless you fully understand
which work they will permanently discard. Back up important work first.
`);
}
