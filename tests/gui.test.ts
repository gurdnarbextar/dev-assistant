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
