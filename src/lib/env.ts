import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadLocalEnv(): void {
  const override = process.env.DEV_ASSISTANT_ENV_FILE;
  const envPath = override
    ? path.resolve(process.cwd(), override)
    : fileURLToPath(new URL('../../.env', import.meta.url));

  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
