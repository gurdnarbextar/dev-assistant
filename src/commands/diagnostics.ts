import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { runGit, isGitRepository } from '../lib/git.js';

function runReadOnly(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) return `Unavailable: ${result.error.message}`;
  if (result.status !== 0) {
    return (result.stderr || result.stdout || `Exited with ${result.status}`).trim();
  }

  return result.stdout.trim() || '(no output)';
}

function findPackageRoot(): string | undefined {
  let current = process.cwd();

  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function collectDiagnostics(): void {
  const root = findPackageRoot() ?? process.cwd();
  const sections: string[] = [];

  sections.push('# Dev Assistant Diagnostic Report');
  sections.push(`Generated: ${new Date().toISOString()}`);
  sections.push(`Working directory: ${process.cwd()}`);
  sections.push(`Project root: ${root}`);
  sections.push(`Platform: ${process.platform} ${process.arch}`);
  sections.push(`Node.js: ${process.version}`);

  sections.push('\n## Git status');
  if (isGitRepository()) {
    sections.push(runGit(['status', '--short', '--branch']));
    sections.push('\n## Recent commits');
    sections.push(runGit([
      'log', '-5', '--date=short',
      '--pretty=format:%h %ad %s',
    ]) || 'No commits yet.');
    sections.push('\n## Unstaged diff summary');
    sections.push(runGit(['diff', '--stat']) || 'No unstaged tracked changes.');
    sections.push('\n## Staged diff summary');
    sections.push(runGit(['diff', '--cached', '--stat']) || 'No staged changes.');
  } else {
    sections.push('Not inside a Git repository.');
  }

  sections.push('\n## Runtime versions');
  sections.push(`Git: ${runReadOnly('git', ['--version'], root)}`);
  sections.push(`npm: ${runReadOnly('npm', ['--version'], root)}`);

  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      sections.push('\n## Package configuration');
      sections.push(`Name: ${pkg.name ?? '(unnamed)'}`);
      sections.push('Scripts:');
      sections.push(
        Object.entries(pkg.scripts ?? {})
          .map(([name, script]) => `- ${name}: ${script}`)
          .join('\n') || '(none)',
      );
      sections.push(
        `Dependency count: ${Object.keys(pkg.dependencies ?? {}).length}`,
      );
      sections.push(
        `Development dependency count: ${Object.keys(pkg.devDependencies ?? {}).length}`,
      );
    } catch {
      sections.push('\n## Package configuration');
      sections.push('Could not parse package.json.');
    }
  }

  const report = `${sections.join('\n')}\n`;
  const outputPath = process.argv[3];

  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.writeFileSync(resolved, report, { flag: 'wx' });
    console.log(`Diagnostic report written to: ${resolved}`);
    console.log('Existing files are never overwritten.');
  } else {
    console.log(report);
  }
}
