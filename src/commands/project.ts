import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

function findProjectRoot(): string {
  let current = process.cwd();

  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) ||
      fs.existsSync(path.join(current, 'pyproject.toml')) ||
      fs.existsSync(path.join(current, 'Cargo.toml')) ||
      fs.existsSync(path.join(current, 'go.mod'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function projectInfo(): void {
  const root = findProjectRoot();
  const markers: [string, string][] = [
    ['package.json', 'Node.js / JavaScript / TypeScript'],
    ['pnpm-workspace.yaml', 'pnpm workspace'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python dependencies'],
    ['Cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['composer.json', 'PHP'],
    ['pom.xml', 'Java / Maven'],
    ['build.gradle', 'Java / Gradle'],
    ['Dockerfile', 'Docker'],
    ['docker-compose.yml', 'Docker Compose'],
  ];

  console.log(`Project root: ${root}`);
  console.log('\nDetected project markers:');

  let detected = false;
  for (const [file, description] of markers) {
    if (fs.existsSync(path.join(root, file))) {
      console.log(`[FOUND] ${file} — ${description}`);
      detected = true;
    }
  }

  if (!detected) console.log('No recognised project markers found.');

  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
        name?: string;
        scripts?: Record<string, string>;
        packageManager?: string;
      };

      console.log(`\nPackage: ${pkg.name ?? '(unnamed)'}`);
      console.log(`Package manager: ${pkg.packageManager ?? 'not specified'}`);
      console.log('\nAvailable scripts:');

      const scripts = pkg.scripts ?? {};
      for (const [name, script] of Object.entries(scripts)) {
        console.log(`  ${name.padEnd(14)} ${script}`);
      }

      if (Object.keys(scripts).length === 0) console.log('  No scripts defined.');
    } catch {
      console.error('Could not parse package.json.');
      process.exitCode = 1;
    }
  }
}

export function runProjectCheck(): void {
  const root = findProjectRoot();
  const packagePath = path.join(root, 'package.json');

  if (!fs.existsSync(packagePath)) {
    console.error('Automated script checks currently require a Node.js package.json.');
    console.error(`Detected project root: ${root}`);
    process.exitCode = 1;
    return;
  }

  let scripts: Record<string, string>;
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    console.error('Could not parse package.json.');
    process.exitCode = 1;
    return;
  }

  const requested = process.argv[3];
  const preferred = ['typecheck', 'lint', 'test', 'build'];
  const selected = requested
    ? [requested]
    : preferred.filter((name) => scripts[name]);

  if (selected.length === 0) {
    console.log('No recognised check scripts found.');
    console.log('Available scripts:');
    for (const name of Object.keys(scripts)) console.log(`  ${name}`);
    return;
  }

  let failed = false;

  for (const name of selected) {
    const script = scripts[name];

    if (!script) {
      console.error(`[SKIP] No script named "${name}".`);
      failed = true;
      continue;
    }

    console.log(`\n========== ${name} ==========`);
    console.log(`Running: npm run ${name}`);

    const result = spawnSync('npm', ['run', name], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });

    if (result.error || result.status !== 0) {
      console.error(`[FAIL] ${name}`);
      failed = true;
    } else {
      console.log(`[PASS] ${name}`);
    }
  }

  if (failed) process.exitCode = 1;
}
