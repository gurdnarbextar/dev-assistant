import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runGit, requireGitRepository } from '../lib/git.js';

const hookMarker = '# Managed by Dev Assistant';
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const builtCli = path.join(toolRoot, 'dist', 'index.js');

const secretPatterns: Array<[string, RegExp]> = [
  ['Private key material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', new RegExp(String.raw`\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github` + `_pat_[A-Za-z0-9_]{20,})\b`)],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Stripe live secret key', /\bsk_live_[0-9A-Za-z]{16,}\b/],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  [
    'Credential assignment',
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{8,})/i,
  ],
];

const placeholder = /^(?:your[-_ ]|example(?:[-_ ]|$)|sample(?:[-_ ]|$)|dummy$|placeholder(?:[-_ ]|$)|changeme$|change[-_ ]me$|replace[-_ ]me$|test[-_ ]|xxx+$|<|process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*)?$|os\.environ$)/i;

function stagedPaths(): string[] {
  const output = runGit([
    'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z',
  ]);
  return output ? output.split('\0').filter(Boolean) : [];
}

function findSensitivePath(file: string): string | undefined {
  const name = path.posix.basename(file);
  const lower = name.toLowerCase();

  if (/^\.env(?:\..+)?$/.test(name) && !/^\.env(?:\..+)?\.example$/.test(name) && name !== '.env.example') {
    return 'environment file';
  }

  if (/^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\..*)?$/.test(lower)) return 'SSH private-key filename';
  if (/^(?:\.netrc|\.npmrc|\.pypirc|credentials|credentials\.json|secrets\.json|service-account(?:\.key)?\.json)$/i.test(name)) {
    return 'credential/configuration filename';
  }
  if (/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(name)) return 'key or certificate file';
  const pathSegments = file.split('/').slice(0, -1);
  if (pathSegments.some((segment) => /^(?:secrets?|credentials?|private-data|sensitive-data)$/i.test(segment))) {
    return 'sensitive directory';
  }
  if (/^(?:production|prod)[-_].*\.(?:sql|dump|bak)$/i.test(name)) return 'production data dump';
  if (/^(?:\.?env\.example|\.?npmrc\.example)$/i.test(name)) return undefined;

  return undefined;
}

function addedLines(
  diff: string,
): Array<{ file: string; line: number; content: string }> {
  const results: Array<{ file: string; line: number; content: string }> = [];
  let file = '';
  let line = 0;

  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ b/')) {
      file = row.slice(6);
      continue;
    }

    if (row.startsWith('+++') || row.startsWith('diff ') || row.startsWith('index ')) {
      continue;
    }

    if (row.startsWith('@@')) {
      const match = row.match(/\+(\d+)(?:,(\d+))?/);
      line = match ? Number(match[1]) - 1 : 0;
      continue;
    }

    if (row.startsWith('+')) {
      line += 1;
      results.push({ file, line, content: row.slice(1) });
    } else if (row.startsWith(' ')) {
      line += 1;
    } else if (row.startsWith('-')) {
      continue;
    }
  }

  return results;
}

export function securityScan(): void {
  if (!requireGitRepository()) {
    process.exitCode = 1;
    return;
  }

  const files = stagedPaths();
  if (files.length === 0) {
    console.log('Security scan: no staged changes to inspect.');
    return;
  }

  const findings: string[] = [];

  for (const file of files) {
    const sensitiveReason = findSensitivePath(file);
    if (sensitiveReason) {
      findings.push(`${file}: sensitive ${sensitiveReason} should not be committed.`);
    }
  }

  const result = spawnSync(
    'git',
    ['diff', '--cached', '--no-ext-diff', '--unified=0', '--no-color', '--'],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    console.error(`Security scan could not read staged diff: ${result.stderr || 'Git failed.'}`);
    process.exitCode = 1;
    return;
  }

  for (const entry of addedLines(result.stdout ?? '')) {
    for (const [label, pattern] of secretPatterns) {
      const match = entry.content.match(pattern);
      if (!match) continue;

      const candidate = match[1] ?? match[0];
      if (placeholder.test(candidate)) continue;

      findings.push(`${entry.file || '(unknown file)'}:${entry.line}: possible ${label}.`);
      break;
    }
  }

  if (findings.length > 0) {
    console.error('\nSECURITY SCAN FAILED\n');
    for (const finding of findings) console.error(`- ${finding}`);
    console.error('\nRemove the sensitive content, stage the corrected changes, and scan again.');
    console.error('Review findings manually; scanners can produce false positives and miss secrets.');
    process.exitCode = 1;
    return;
  }

  console.log(`Security scan passed: ${files.length} staged file(s) checked.`);
}

export function securityHook(): void {
  if (!requireGitRepository()) {
    process.exitCode = 1;
    return;
  }

  const action = process.argv[3] ?? 'status';
  const hooksPath = runGit(['rev-parse', '--git-path', 'hooks']);
  const hookFile = path.resolve(process.cwd(), hooksPath, 'pre-commit');

  if (action === 'status') {
    if (fs.existsSync(hookFile) && fs.readFileSync(hookFile, 'utf8').includes(hookMarker)) {
      console.log('Dev Assistant pre-commit security hook is installed.');
    } else {
      console.log('Dev Assistant pre-commit security hook is not installed.');
    }
    return;
  }

  if (action === 'install') {
    if (fs.existsSync(hookFile)) {
      const existing = fs.readFileSync(hookFile, 'utf8');
      if (existing.includes(hookMarker)) {
        console.log('Dev Assistant pre-commit security hook is already installed.');
        return;
      }
      console.error(`A pre-commit hook already exists at ${hookFile}. It was not overwritten.`);
      console.error('Integrate "dev-assistant security-scan" into that hook manually.');
      process.exitCode = 1;
      return;
    }

    if (!fs.existsSync(builtCli)) {
      console.error('Built CLI not found. Run npm run build from the Dev Assistant project first.');
      process.exitCode = 1;
      return;
    }

    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const hook = [
      '#!/bin/sh',
      hookMarker,
      `exec ${quote(process.execPath)} ${quote(builtCli)} security-scan`,
      '',
    ].join('\n');

    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, hook, { mode: 0o755, flag: 'wx' });
    fs.chmodSync(hookFile, 0o755);
    console.log(`Installed Dev Assistant pre-commit security hook: ${hookFile}`);
    return;
  }

  if (action === 'uninstall') {
    if (!fs.existsSync(hookFile)) {
      console.log('No pre-commit hook exists.');
      return;
    }

    const existing = fs.readFileSync(hookFile, 'utf8');
    if (!existing.includes(hookMarker)) {
      console.error('The existing hook is not managed by Dev Assistant; it was left untouched.');
      process.exitCode = 1;
      return;
    }

    fs.unlinkSync(hookFile);
    console.log('Removed Dev Assistant pre-commit security hook.');
    return;
  }

  console.error('Usage: dev-assistant security-hook [status|install|uninstall]');
  process.exitCode = 1;
}
