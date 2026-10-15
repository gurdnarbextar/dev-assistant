#!/usr/bin/env node
import process from 'node:process';
import { loadLocalEnv } from './lib/env.js';
import { gitStatus, gitDiff, gitSummary, gitLog, gitBranches, gitCheck } from './commands/inspection.js';
import { doctor } from './commands/doctor.js';
import { gitCommit, gitUndoHelp } from './commands/commit.js';
import { projectInfo, runProjectCheck } from './commands/project.js';
import { collectDiagnostics } from './commands/diagnostics.js';
import { githubDoctor, githubRepo, githubIssues, githubPrs, githubRuns, githubPrCreate } from './commands/github.js';
import { aiConfig, aiAsk, aiDebug, aiReview, aiModels, aiChat } from './commands/ai.js';
import { gitStage, gitBranch } from './commands/workflow.js';
import { securityScan, securityHook } from './commands/security.js';
import { automationCommand } from './commands/automation.js';
import { aiRepair } from './commands/repair.js';

loadLocalEnv();

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`
Dev Assistant v${VERSION}

A local Git development automation toolkit.

Usage:
  dev-assistant <command> [options]

Git inspection:
  git-status                 Show repository status
  git-diff [--staged]        Show unstaged or staged changes
  git-summary               Summarise staged and unstaged changes
  git-log [count]           Show recent commits (default 10)
  git-branches              List local branches
  git-branch list           List branches
  git-branch create <name>  Create a branch without switching
  git-stage <file> [...]    Stage explicitly named files
  git-check                 Check repository integrity and whitespace

Git workflow:
  git-commit "message"      Preview a commit using staged files
  git-commit "message" --confirm
                             Create the commit after explicit confirmation
  git-undo-help             Show recovery guidance

Utilities:
  ai-config                  Show AI configuration (without secrets)
  ai-models                  List configured AI model aliases
  chat                      Start interactive AI chat
  ai-ask [--model alias] "question"
                             Ask a selected AI model (Gemini is the default)
  ai-review [--staged] [--send]
                             Review a diff with AI; sending requires --send
  ai-debug "error" [--file report.md]
                             Request AI debugging assistance
  ai-repair [--apply] [--max-attempts 1-3]
                             Propose or apply a bounded AI repair
  gh-doctor                  Check GitHub CLI authentication
  gh-repo                    View the current GitHub repository
  gh-issues [state]          List GitHub issues
  gh-prs [state]             List pull requests
  gh-pr-create --title "..." --body "..." [--base branch] [--draft]
                             Create a PR from a published feature branch
  gh-runs                    List GitHub Actions runs
  diagnose [output.md]       Collect a local diagnostic report
  project-info              Detect project type and list scripts
  check [script]             Run project checks (typecheck, lint, test, build)
  security-scan             Scan staged changes for likely secrets
  security-hook [action]    Manage the pre-commit security hook
  automation <action>       Manage local automation
                             init/status/config/history/run/daemon
  doctor                    Check development tool availability
  version                   Show version
  help                      Show commands

Automatic commits and pushes are disabled by default.
`);
}

const command = process.argv[2];

try {
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`Dev Assistant v${VERSION}`);
      break;
    case 'git-status':
      gitStatus();
      break;
    case 'git-diff':
      gitDiff();
      break;
    case 'git-summary':
      gitSummary();
      break;
    case 'git-log':
      gitLog();
      break;
    case 'git-branches':
      gitBranches();
      break;
    case 'git-check':
      gitCheck();
      break;
    case 'git-commit':
      gitCommit();
      break;
    case 'git-undo-help':
      gitUndoHelp();
      break;
    case 'ai-review':
      await aiReview();
      break;
    case 'ai-repair':
      await aiRepair();
      break;
    case 'git-stage':
      gitStage();
      break;
    case 'git-branch':
      gitBranch();
      break;
    case 'ai-config':
      aiConfig();
      break;
    case 'ai-models':
      aiModels();
      break;
    case 'chat':
      await aiChat();
      break;
    case 'ai-ask':
      await aiAsk();
      break;
    case 'ai-debug':
      await aiDebug();
      break;
    case 'gh-doctor':
      githubDoctor();
      break;
    case 'gh-repo':
      githubRepo();
      break;
    case 'gh-issues':
      githubIssues();
      break;
    case 'gh-prs':
      githubPrs();
      break;
    case 'gh-runs':
      githubRuns();
      break;
    case 'gh-pr-create':
      githubPrCreate();
      break;
    case 'diagnose':
      collectDiagnostics();
      break;
    case 'project-info':
      projectInfo();
      break;
    case 'check':
      runProjectCheck();
      break;
    case 'security-scan':
      securityScan();
      break;
    case 'security-hook':
      securityHook();
      break;
    case 'automation':
      await automationCommand();
      break;
    case 'doctor':
      doctor();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Command failed: ${detail}`);
  process.exitCode = 1;
}
