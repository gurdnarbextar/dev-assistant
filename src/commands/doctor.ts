import { spawnSync } from 'node:child_process';

export function doctor(): void {
  const tools = [
    ['Node.js', 'node', '--version'],
    ['npm', 'npm', '--version'],
    ['Git', 'git', '--version'],
    ['GitHub CLI', 'gh', '--version'],
  ] as const;

  console.log('Dev Assistant environment diagnostics\n');

  for (const [label, command, arg] of tools) {
    const result = spawnSync(command, [arg], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (result.status === 0) {
      const version = result.stdout.trim().split('\n')[0];
      console.log(`[OK]      ${label}: ${version}`);
    } else {
      console.log(`[MISSING] ${label}: command "${command}" not available`);
    }
  }
}
