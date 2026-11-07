import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedGuiRequest } from '../src/commands/gui.js';

const origin = 'http://127.0.0.1:4567';
const token = 'a'.repeat(64);

test('GUI accepts a matching loopback host, origin and token', () => {
  assert.equal(isTrustedGuiRequest({
    host: '127.0.0.1:4567',
    origin,
    'x-dev-assistant-token': token,
  }, origin, token), true);
});

test('GUI rejects missing or foreign origins', () => {
  for (const headers of [
    { host: '127.0.0.1:4567', 'x-dev-assistant-token': token },
    { host: '127.0.0.1:4567', origin: 'https://attacker.invalid', 'x-dev-assistant-token': token },
    { host: 'attacker.invalid', origin, 'x-dev-assistant-token': token },
  ]) {
    assert.equal(isTrustedGuiRequest(headers, origin, token), false);
  }
});

test('GUI rejects missing and incorrect request tokens', () => {
  assert.equal(isTrustedGuiRequest({
    host: '127.0.0.1:4567',
    origin,
  }, origin, token), false);
  assert.equal(isTrustedGuiRequest({
    host: '127.0.0.1:4567',
    origin,
    'x-dev-assistant-token': 'wrong-token',
  }, origin, token), false);
});


import { validateRemoteGitUrl } from '../src/lib/remote-repository.js';

test('remote project URLs accept HTTPS and SSH clone formats', () => {
  assert.equal(
    validateRemoteGitUrl('https://github.com/example/project.git'),
    'https://github.com/example/project.git',
  );
  assert.equal(
    validateRemoteGitUrl('git@github.com:example/project.git'),
    'git@github.com:example/project.git',
  );
  assert.equal(
    validateRemoteGitUrl('ssh://git@gitlab.com/example/project.git'),
    'ssh://git@gitlab.com/example/project.git',
  );
});

test('remote project URLs reject local paths, unsupported protocols and embedded credentials', () => {
  for (const value of [
    '/home/user/project',
    'file:///tmp/project',
    'git://github.com/example/project.git',
    'https://user:password@example.com/project.git',
    'https://example.com/project.git?token=secret',
    '',
  ]) {
    assert.throws(() => validateRemoteGitUrl(value));
  }
});
