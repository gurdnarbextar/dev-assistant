# Dev Assistant

A local-first command-line toolkit for Git inspection, safer development
workflows, project diagnostics, GitHub CLI operations, and optional AI
assistance.

## Requirements

- Node.js 22 or later
- npm
- Git
- GitHub CLI (`gh`) for GitHub commands
- An API-compatible AI provider for AI commands

## Setup

```bash
npm install
npm run build
npm link
dev-assistant help
```

To use the development entry point without linking:

```bash
npm run dev -- help
```

After source changes, rebuild with `npm run build`.

## Commands

### Git inspection

```bash
dev-assistant git-status
dev-assistant git-diff
dev-assistant git-diff --staged
dev-assistant git-summary
dev-assistant git-log 15
dev-assistant git-branches
dev-assistant git-check
```

### Git workflow

```bash
dev-assistant git-stage src/index.ts README.md
dev-assistant git-branch list
dev-assistant git-branch create feature/my-change
dev-assistant git-commit "Describe the change"
dev-assistant git-commit "Describe the change" --confirm
dev-assistant git-undo-help
```

Staging names files explicitly. A commit requires staged changes and the
explicit `--confirm` flag. Creating a branch does not switch to it.
The toolkit does not push automatically.

### Project checks and diagnostics

```bash
dev-assistant project-info
dev-assistant check
dev-assistant check test
dev-assistant diagnose
dev-assistant diagnose diagnostics.md
dev-assistant doctor
```

Project checks execute scripts defined by the target project's package
configuration. Run them only in projects whose code and scripts you trust.
Diagnostic reports may include local paths, repository details, and project
metadata; review a report before sharing it.

### GitHub

Authenticate the GitHub CLI separately with `gh auth login`, then use:

```bash
dev-assistant gh-doctor
dev-assistant gh-repo
dev-assistant gh-issues
dev-assistant gh-issues all
dev-assistant gh-prs
dev-assistant gh-prs all
dev-assistant gh-runs
```

These commands use the GitHub CLI and its existing authentication.

### AI assistance

Create a private `.env` file in the toolkit's root directory, using
`.env.example` as a reference:

```dotenv
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your-model-name
AI_API_KEY=your-secret-key
```

Keep real keys out of Git. Shell environment variables take precedence over
values in `.env`. The optional `DEV_ASSISTANT_ENV_FILE` variable can specify
a different environment file; relative paths are resolved from the current
working directory.

```bash
dev-assistant ai-config
dev-assistant ai-ask "Explain this error"
dev-assistant ai-debug "Describe the error and relevant context"
dev-assistant ai-debug "Describe the error" --file diagnostics.md
dev-assistant ai-review
dev-assistant ai-review --staged
dev-assistant ai-review --staged --send
```

The API URL must expose an OpenAI-compatible Chat Completions endpoint.
`ai-config` does not print the API key. AI requests send the supplied prompt
or selected diff to the configured provider. `ai-review` previews locally
unless `--send` is specified. Only tracked diffs are included in AI reviews;
untracked files are not automatically uploaded. Files passed to `ai-debug`
are sent to the provider, so inspect them first.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Security notes

- Review staged changes before committing.
- Do not put credentials or private keys in source control.
- Review diagnostic reports and AI inputs before sharing them.
- AI requests transmit their prompts and included content to the configured
  external provider.
- GitHub commands depend on the permissions granted to your `gh` account.

## Staged-change security scanning

Run a local scan before committing:

```bash
dev-assistant security-scan
```

Install an optional Git pre-commit hook in the current repository:

```bash
dev-assistant security-hook install
dev-assistant security-hook status
dev-assistant security-hook uninstall
```

The scanner checks staged filenames and newly added diff lines for common
credential patterns. It does not upload source code. A detected issue blocks
the commit when the hook is installed. Existing hooks are never overwritten.

This is a defence-in-depth measure, not a guarantee. Pattern scanners can
produce false positives and miss secrets. Review staged changes, use dedicated
secret-scanning tools where appropriate, and rotate any credential that may
have been exposed. `.gitignore` does not remove files already tracked by Git.
