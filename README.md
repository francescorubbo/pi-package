# Pi Extensions Package

This repository contains custom extensions for the [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

### Shell Command Blocker (`block-shell-commands.ts`)
Prevents the agent from executing shell commands by default. When a command is attempted:
- It checks an allowlist stored in `.pi/shell-allowlist.json`.
- It extracts the executable from each command, ignoring redirection targets, heredoc bodies, variable assignments, comments, and no-op builtins such as `true`.
- If the command is not allowed, it prompts the user to:
  - **Allow once**: Permits the current execution.
  - **Always allow**: Adds the command's first token (e.g., `uv` for `uv sync`) to the allowlist.
  - **Block**: Rejects the execution.

The shell parsing logic lives in `extensions/shell-command-parser.ts` and is covered by unit tests.

### UV Python Runner (`pi-uv.ts`)
Routes Python-related commands (e.g., `python`, `pytest`, `ruff`) through `uv run`.
- **Prompt**: a system-prompt guideline tells the model to invoke Python tools as `uv run ...` itself, so the command it emits is the command that executes and tool output matches its intent.
- **Enforcement**: if the model still invokes a Python tool directly, the `tool_call` handler rewrites it to `uv run` as a fallback.
- Detects the nearest `uv.lock` file to determine the project root.
- Prepends `uv run --project <path>` to each rewritten Python invocation.
- Finds path-qualified interpreters (`.venv/bin/python`, `/usr/bin/python3`) and Python commands anywhere in a compound command (`cd x && .venv/bin/pytest`), using the shell-aware parser in `shell-command-parser.ts`.
- Ensures commands are executed within the correct virtual environment without manual activation.

### Strip CWD Prefix (`strip-cwd-prefix.ts`)
Some models prepend `cd <absolute cwd> &&` to every bash command even though commands already run in the working directory. This extension applies two mitigations:
- **Cleanup**: before each bash command runs, a leading no-op `cd <cwd>` prefix is stripped. Only prefixes that resolve back to a valid working directory are removed, so intentional `cd` into another directory is preserved. Handles quoting, `cd --`, chained `cd`s, and `;`/newline separators.
- **Prompt**: a system-prompt guideline tells the model that bash already starts in the working directory.

In SSH sessions the session cwd (the local path) differs from the directory commands actually execute in. The ssh extension publishes its remote cwd on pi's event bus (`remote-cwd.ts`), and this extension accepts both directories, so `cd <remote-project-root> && ...` is stripped as well. The rewriting logic lives in `extensions/strip-cwd-prefix-core.ts` and is covered by unit tests.

### SSH Remote Execution (`ssh.ts`)
Delegates tool operations (read, write, edit, bash) to a remote machine via SSH.
- Supports key-based authentication (`BatchMode=yes`).
- Usage:
  - `pi -e ./extensions/ssh.ts --ssh user@host`
  - `pi -e ./extensions/ssh.ts --ssh user@host:/remote/path`
- Robust path mapping (local paths are mapped into the remote tree; remote absolute paths are accepted as-is), stdin file streaming, and connection error handling.
- Prepends the conventional user-local bin directory (`$HOME/.local/bin`) to the remote `PATH` on every operation. Non-interactive SSH does not source the user's profile, so tools installed there (notably `uv`) would otherwise be missing and every command would need an `export PATH=...` prefix.
- Advertises the remote working directory in the system prompt and publishes it on pi's event bus (`remote-cwd.ts`) so `strip-cwd-prefix.ts` can remove redundant `cd` prefixes. It mutates the structured system-prompt options rather than returning a whole prompt, so guidelines added by other extensions are preserved.


## Prompt Guideline Ordering

Pi diffs the generated system-prompt sections against what the model already has and patches only the sections that change. All `promptGuidelines` land in the single `<rules>` section, so the order in which extensions add them affects the rendered text: the same set in a different order is still a cache miss.

Extensions in this package add guidelines through `extensions/prompt-guidelines.ts`, which keeps the collection unique and sorted. The rendered `<rules>` section is therefore identical across turns and independent of extension load order. Guidelines are also static per session (the SSH guideline embeds the resolved remote host and cwd, which are fixed once `session_start` completes), so the section changes at most once, on the first turn.

## Installation

### Local Development
To test extensions without installing them:
```bash
pi -e ./extensions/block-shell-commands.ts
```

### Install via Git
You can install this package directly into your pi environment:
```bash
pi install git:github.com/your-username/pi-package
```

## Development

### Type Checking
This project uses TypeScript. To verify that the extensions are correctly typed against the Pi SDK:
```bash
npm install
npm run typecheck
```

### Testing
Unit tests use [Vitest](https://vitest.dev/):
```bash
npm test
```

### Project Structure
- `extensions/`: Contains the TypeScript source for all extensions.
- `test/`: Unit tests for extension logic.
- `.github/workflows/`: CI pipeline for type checking and tests.
- `package.json`: Defines the pi package metadata and dependencies.
