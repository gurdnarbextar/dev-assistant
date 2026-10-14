import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  getRepositoryContext,
  readRepositoryFile,
} from '../src/lib/repository.js';

function withRepository(run: (root: string, outside: string) => void): void {
  const originalDirectory = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-repo-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-assistant-outside-'));

  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'repo-test@example.invalid'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.name', 'Repository Test'], {
      cwd: root,
    });

    process.chdir(root);
    run(root, outside);
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test('repository reader reads a regular file inside the repository', () => {
  withRepository((root) => {
    fs.writeFileSync(path.join(root, 'README.md'), '# Test project\n');

    assert.equal(readRepositoryFile('README.md'), '# Test project\n');
  });
});

test('repository reader blocks environment files and Git metadata', () => {
  withRepository((root) => {
    fs.writeFileSync(path.join(root, '.env.local'), 'EXAMPLE=dummy\n');

    assert.equal(readRepositoryFile('.env.local'), null);
    assert.equal(readRepositoryFile('.git/config'), null);
  });
});

test('repository reader blocks parent-directory traversal', () => {
  withRepository((_root, outside) => {
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside data');

    assert.equal(readRepositoryFile('../outside.txt'), null);
  });
});

test('repository reader blocks symlinks that escape the repository', () => {
  withRepository((root, outside) => {
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside data');
    fs.symlinkSync(
      path.join(outside, 'outside.txt'),
      path.join(root, 'outside-link.txt'),
    );

    assert.equal(readRepositoryFile('outside-link.txt'), null);
  });
});

test('repository reader rejects files larger than 40,000 bytes', () => {
  withRepository((root) => {
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(40_001));

    assert.equal(readRepositoryFile('large.txt'), null);
  });
});

test('repository context excludes tracked environment files', () => {
  withRepository((root) => {
    fs.writeFileSync(path.join(root, '.env.local'), 'EXAMPLE=dummy\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Safe project\n');

    execFileSync('git', ['add', '--', '.env.local', 'README.md'], {
      cwd: root,
    });

    const context = getRepositoryContext();

    assert.ok(context);
    assert.ok(context.files.includes('README.md'));
    assert.ok(!context.files.includes('.env.local'));
  });
});
