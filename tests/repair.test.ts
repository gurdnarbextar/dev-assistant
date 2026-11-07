import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePatchPaths } from '../src/commands/repair.js';

function patchFor(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

test('repair accepts ordinary source and test paths', () => {
  assert.doesNotThrow(() =>
    validatePatchPaths(patchFor('src/commands/example.ts')),
  );
  assert.doesNotThrow(() =>
    validatePatchPaths(patchFor('tests/example.test.ts')),
  );
});

test('repair rejects environment files', () => {
  assert.throws(
    () => validatePatchPaths(patchFor('.env.local')),
    /prohibited or unsafe path/i,
  );
  assert.throws(
    () => validatePatchPaths(patchFor('config/.env.production')),
    /prohibited or unsafe path/i,
  );
});

test('repair rejects lockfiles and generated output', () => {
  for (const file of [
    'package-lock.json',
    'dist/index.js',
    'node_modules/example/index.js',
    '.git/config',
    'coverage/report.json',
  ]) {
    assert.throws(
      () => validatePatchPaths(patchFor(file)),
      /prohibited or unsafe path/i,
      `Expected rejection for ${file}`,
    );
  }
});

test('repair rejects traversal and ambiguous diff headers', () => {
  assert.throws(
    () => validatePatchPaths(patchFor('../outside.ts')),
    /prohibited or unsafe path/i,
  );
  assert.throws(
    () => validatePatchPaths(
      'diff --git "a/file with spaces.ts" "b/file with spaces.ts"\n',
    ),
    /ambiguous or unsupported/i,
  );
  assert.throws(
    () => validatePatchPaths('not a Git diff'),
    /no Git file headers/i,
  );
});

test('repair rejects file mode, rename, copy and binary patch operations', () => {
  for (const metadata of [
    'new file mode 120000',
    'old mode 100644\nnew mode 100755',
    'rename from src/old.ts\nrename to src/new.ts',
    'copy from src/old.ts\ncopy to src/new.ts',
    'GIT binary patch',
  ]) {
    assert.throws(
      () => validatePatchPaths(`${patchFor('src/example.ts')}\n${metadata}\n`),
      /unsupported mode change|rename|copy|binary/i,
    );
  }
});

test('repair rejects mismatched text headers and file creation', () => {
  assert.throws(
    () => validatePatchPaths([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/other.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')),
    /matching text-file headers/i,
  );
  assert.throws(
    () => validatePatchPaths([
      'diff --git a/src/new.ts b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+new',
    ].join('\n')),
    /matching text-file headers/i,
  );
});
