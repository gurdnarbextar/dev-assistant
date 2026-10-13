import fs from 'node:fs';
import process from 'node:process';
import { runGit, isGitRepository } from '../lib/git.js';

interface AIConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function getConfig(): AIConfig {
  return {
    baseUrl:
      process.env.AI_BASE_URL ||
      process.env.OPENROUTER_BASE_URL ||
      'https://openrouter.ai/api/v1',
    model:
      process.env.AI_MODEL ||
      process.env.OPENROUTER_GEMINI_MODEL ||
      '',
    apiKey:
      process.env.AI_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      '',
  };
}

const MODEL_ALIASES: Record<string, string> = {
  gemini: 'OPENROUTER_GEMINI_MODEL',
  'openai-mini': 'OPENROUTER_OPENAI_MINI_MODEL',
  'openai-nano': 'OPENROUTER_OPENAI_NANO_MODEL',
  'deepseek-flash': 'OPENROUTER_DEEPSEEK_FLASH_MODEL',
  'deepseek-pro': 'OPENROUTER_DEEPSEEK_PRO_MODEL',
  'deepseek-vision': 'OPENROUTER_DEEPSEEK_VISION_MODEL',
};

function extractModelOption(args: string[]): {
  args: string[];
  model?: string;
  error: boolean;
} {
  const remaining = [...args];
  const index = remaining.indexOf('--model');

  if (index === -1) {
    return { args: remaining, error: false };
  }

  const model = remaining[index + 1];

  if (!model || model.startsWith('--')) {
    console.error('Usage: --model <alias-or-provider/model-id>');
    return { args: remaining, error: true };
  }

  remaining.splice(index, 2);
  return { args: remaining, model, error: false };
}

export function aiModels(): void {
  console.log('Configured AI models');
  console.log(`Default: ${process.env.AI_MODEL || process.env.OPENROUTER_GEMINI_MODEL || '(not configured)'}`);
  console.log('');

  for (const [alias, variable] of Object.entries(MODEL_ALIASES)) {
    const model = process.env[variable];
    console.log(`${alias.padEnd(16)} ${model || '(not configured)'}`);
  }

  console.log('');
  console.log('Select a model with: ai-ask --model <alias> "Your question"');
}

export function aiConfig(): void {
  const config = getConfig();

  console.log('AI provider configuration');
  console.log(`API base URL: ${config.baseUrl}`);
  console.log(`Model: ${config.model || '(not configured)'}`);
  console.log(`API key: ${config.apiKey ? 'configured (value hidden)' : 'not configured'}`);
  console.log('\nRequired environment variables:');
  console.log('  AI_API_KEY   Provider API key');
  console.log('  AI_MODEL     Model identifier supported by that provider');
  console.log('Optional:');
  console.log('  AI_BASE_URL  OpenAI-compatible API base URL');
}

async function askAI(prompt: string, modelChoice?: string): Promise<void> {
  const config = getConfig();
  let selectedModel = config.model;

  if (modelChoice) {
    const variable = MODEL_ALIASES[modelChoice.toLowerCase()];

    if (variable) {
      selectedModel = process.env[variable] || '';
      if (!selectedModel) {
        console.error(`Model alias "${modelChoice}" is not configured in .env.`);
        process.exitCode = 1;
        return;
      }
    } else if (modelChoice.includes('/')) {
      selectedModel = modelChoice;
    } else {
      console.error(`Unknown model alias: ${modelChoice}`);
      console.error(`Available aliases: ${Object.keys(MODEL_ALIASES).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!config.apiKey || !selectedModel) {
    console.error('AI is not configured. Set AI_API_KEY and AI_MODEL first.');
    process.exitCode = 1;
    return;
  }

  let endpoint: URL;

  try {
    endpoint = new URL(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`);
  } catch {
    console.error('AI_BASE_URL is not a valid URL.');
    process.exitCode = 1;
    return;
  }

  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    console.error('Refusing to send an API key over plain HTTP to a non-local host.');
    process.exitCode = 1;
    return;
  }

  console.log(`Sending request to ${endpoint.origin} using model "${selectedModel}"...`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      await response.body?.cancel();
      console.error(
        `AI provider returned HTTP ${response.status}. Check provider configuration and try again.`,
      );
      process.exitCode = 1;
      return;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message?: string };
    };

    const answer = data.choices?.[0]?.message?.content;

    if (!answer) {
      console.error(data.error?.message || 'The provider returned no text response.');
      process.exitCode = 1;
      return;
    }

    console.log('\n--- AI RESPONSE ---\n');
    console.log(answer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`AI request failed: ${message}`);
    process.exitCode = 1;
  }
}

export async function aiAsk(): Promise<void> {
  const parsed = extractModelOption(process.argv.slice(3));
  if (parsed.error) {
    process.exitCode = 1;
    return;
  }

  const prompt = parsed.args.join(' ').trim();

  if (!prompt) {
    console.error('Usage: dev-assistant ai-ask [--model alias] "Your question"');
    process.exitCode = 1;
    return;
  }

  await askAI(prompt, parsed.model);
}

export async function aiDebug(): Promise<void> {
  const parsed = extractModelOption(process.argv.slice(3));
  if (parsed.error) {
    process.exitCode = 1;
    return;
  }

  const args = parsed.args;
  const fileFlag = args.indexOf('--file');
  let fileContext = '';

  if (fileFlag !== -1) {
    const filePath = args[fileFlag + 1];

    if (!filePath) {
      console.error('Usage: dev-assistant ai-debug "error" [--file report.md]');
      process.exitCode = 1;
      return;
    }

    try {
      fileContext = fs.readFileSync(filePath, 'utf8');
    } catch {
      console.error(`Cannot read diagnostic file: ${filePath}`);
      process.exitCode = 1;
      return;
    }

    args.splice(fileFlag, 2);
  }

  const errorDescription = args.join(' ').trim();

  if (!errorDescription) {
    console.error('Usage: dev-assistant ai-debug "error description" [--file report.md]');
    process.exitCode = 1;
    return;
  }

  const prompt = [
    'Act as a senior software debugging engineer.',
    'Analyse the reported problem. Separate confirmed facts from hypotheses.',
    'Identify likely root causes, propose a minimal safe fix, and provide verification steps.',
    'Do not claim to have executed commands or inspected files that were not supplied.',
    '',
    'Problem or error:',
    errorDescription,
    fileContext ? '\nUser-supplied diagnostic context:\n' + fileContext : '',
  ].join('\n');

  if (fileContext) {
    console.log('The supplied file contents will be sent to the configured AI provider.');
  }

  await askAI(prompt, parsed.model);
}


export async function aiReview(): Promise<void> {
  if (!isGitRepository()) {
    console.error('Run this command from inside a Git repository.');
    process.exitCode = 1;
    return;
  }

  const parsed = extractModelOption(process.argv.slice(3));
  if (parsed.error) {
    process.exitCode = 1;
    return;
  }

  const args = parsed.args;
  const send = args.includes('--send');
  const stagedOnly = args.includes('--staged');

  let diff: string;
  try {
    diff = stagedOnly
      ? runGit(['diff', '--cached', '--no-ext-diff', '--'])
      : [
          runGit(['diff', '--no-ext-diff', '--']),
          runGit(['diff', '--cached', '--no-ext-diff', '--']),
        ].filter(Boolean).join('\n\n');
  } catch {
    console.error('Unable to collect the requested Git diff.');
    process.exitCode = 1;
    return;
  }

  if (!diff) {
    console.error('No tracked changes found to review.');
    console.error('Untracked files are not included in this review.');
    process.exitCode = 1;
    return;
  }

  if (!send) {
    console.log('Review preview only. No code has been sent to an AI provider.');
    console.log(`Diff size: ${diff.length} characters.`);
    console.log('\nTo send this diff for review, run:');
    console.log(`dev-assistant ai-review${stagedOnly ? ' --staged' : ''} --send`);
    console.log('\nReview the diff yourself first with git-diff.');
    return;
  }

  const prompt = [
    'Act as a senior software engineer conducting a code review.',
    'Review only the supplied diff. Prioritise correctness, security, regressions, and maintainability.',
    'Report findings by severity and include file/line references when visible.',
    'Distinguish definite bugs from possible concerns. If no issues are found, say so.',
    'Do not claim tests were run.',
    '',
    'Git diff:',
    diff,
  ].join('\n');

  console.log('Sending the selected tracked diff to the configured AI provider.');
  await askAI(prompt, parsed.model);
}
