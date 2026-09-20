# Pi Extensions Package

This repository contains custom extensions for the [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

### Shell Command Blocker (`block-shell-commands.ts`)
Prevents the agent from executing shell commands by default. When a command is attempted:
- It checks an allowlist stored in `.pi/shell-allowlist.json`.
- If the command is not allowed, it prompts the user to:
  - **Allow once**: Permits the current execution.
  - **Always allow**: Adds the command's first token (e.g., `uv` for `uv sync`) to the allowlist.
  - **Block**: Rejects the execution.

### UV Python Runner (`pi-uv.ts`)
Automatically rewrites Python-related commands (e.g., `python`, `pytest`, `ruff`) to use `uv run`.
- Detects the nearest `uv.lock` file to determine the project root.
- Prepends `uv run --project <path>` to the command.
- Ensures commands are executed within the correct virtual environment without manual activation.


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

### Project Structure
- `extensions/`: Contains the TypeScript source for all extensions.
- `.github/workflows/`: CI pipeline for type checking.
- `package.json`: Defines the pi package metadata and dependencies.
