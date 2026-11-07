import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

export function validateRemoteGitUrl(value: string): string {
  const remote = value.trim();
  if (!remote || remote.length > 2_048 || /[\u0000-\u0020\u007f]/.test(remote)) {
    throw new Error('Enter a valid HTTPS or SSH Git clone URL.');
  }

  if (/^[^/@:]+@[^/:]+:.+$/.test(remote)) {
    const match = remote.match(/^([^/@:]+)@([^/:]+):(.+)$/);
    const host = match?.[2];
    const repositoryPath = match?.[3];
    if (!host || !repositoryPath || !host.includes('.') || repositoryPath.startsWith('-')) {
      throw new Error('Enter a valid SSH clone URL.');
    }
    return remote;
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error('Use an HTTPS URL or an SSH clone URL.');
  }

  if (
    !['https:', 'ssh:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    (parsed.protocol === 'https:' && parsed.username.length > 0) ||
    (parsed.protocol === 'ssh:' && parsed.username.length > 0 && parsed.username !== 'git') ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname === '/' ||
    parsed.pathname.split('/').some((part) => part === '..')
  ) {
    throw new Error('Only credential-free HTTPS and SSH Git URLs are supported.');
  }

  return remote;
}

function repositoryName(remote: string): string {
  const withoutSuffix = remote.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const name = withoutSuffix.slice(Math.max(withoutSuffix.lastIndexOf('/'), withoutSuffix.lastIndexOf(':')) + 1);
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!safe || safe === '.' || safe === '..') throw new Error('Could not determine a safe repository folder name.');
  return safe;
}

function runClone(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '';
    let settled = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        reject(new Error('Git clone timed out after five minutes.'));
      }
    }, CLONE_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error('Could not start Git. Ensure Git is installed and available on PATH.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error('Git clone failed. Check the URL, network connection and Git credentials.' + (output.trim() ? '\n' + output.trim() : '')));
    });
  });
}

export async function cloneRemoteRepository(value: string, branchValue?: string): Promise<string> {
  const remote = validateRemoteGitUrl(value);
  const branch = branchValue?.trim();
  if (branch && (branch.length > 250 || branch.startsWith('-') || /[\u0000-\u0020\u007f]/.test(branch))) {
    throw new Error('Enter a valid branch or tag name.');
  }

  const workspace = path.join(os.homedir(), '.dev-assistant', 'projects');
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const destination = path.join(workspace, repositoryName(remote));
  try {
    await fs.access(destination);
    throw new Error('A project with this name already exists in the Dev Assistant workspace. Rename or move it before cloning again.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = await fs.mkdtemp(path.join(workspace, '.clone-'));
  try {
    const args = ['clone'];
    if (branch) args.push('--branch', branch, '--single-branch');
    args.push('--', remote, temporary);
    await runClone(args);
    await fs.rename(temporary, destination);
    return destination;
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
