---
name: getting-started
description: Set up a fresh clone of this repo for contributing. Checks uv and gh, installs Python dependencies, and optionally sets up the viewer site in site/.
disable-model-invocation: true
---

# Getting Started

Guide a new contributor through setup, one step at a time.
Assume the user has already cloned the repo and the shell is at the repo root.
The source of truth is `CONTRIBUTING.MD`. Read it first. If it differs from this skill, follow `CONTRIBUTING.MD`.

Use the repo glossary in `AGENTS.md`.

## Rules

- Do one step at a time. Tell the user the result of each step before you start the next.
- Ask before you install anything or change any setting.
- Before you give install commands, read the current docs (use WebFetch). Do not use commands from memory. The docs are listed in each step.
- Use the platform found in step 0 for every install command and path. Do not ask the user for the platform.
- If a step fails, show the error, explain the cause in plain words, and stop. Do not try other fixes without asking.

## Steps

0. **Identify the platform.**
   Do this first, before any other step and without asking the user.
   Run `uname -s` and `uname -m`. If `uname` is not available, run `echo $OS` (Windows sets `OS=Windows_NT`) and `echo %PROCESSOR_ARCHITECTURE%`.
   Also find the shell and the package managers that are present (for example `brew`, `apt`, `dnf`, `winget`, `scoop`) with `command -v`.
   Tell the user what you found in one line (for example "macOS arm64, zsh, Homebrew").
   Completion: you know the OS, the CPU architecture, the shell, and the package managers.

1. **Confirm the repo root.**
   Run `git rev-parse --show-toplevel` and check that `pyproject.toml` and `CONTRIBUTING.MD` are in that folder. If not, tell the user to `cd` into the clone and stop.
   Completion: you are in the repo root.

2. **Check `uv`.**
   Run `uv --version`. The version must be 0.13.4 or higher. Older versions have known security issues.
   - Missing: read <https://docs.astral.sh/uv/getting-started/installation/>. Show the install command for the platform from step 0 (prefer a package manager that is present). Ask if you may run it. After the install, run `uv --version` again. If the shell does not find `uv`, tell the user to open a new shell.
   - Too old: if `uv self update` works for this install method, offer it. If `uv` came from a package manager (for example Homebrew), give the upgrade command for that manager from the docs instead.
   Completion: `uv --version` shows 0.13.4 or higher.

3. **Install the Python dependencies.**
   The project needs Python 3.11 or later. `uv` fetches a fitting Python if none is present.
   Run `uv sync`, then `uv run leningrad --help`.
   Completion: the help text lists the `leningrad` commands.

4. **Set up the viewer site (optional).**
   Ask if the user wants to set up the Astro viewer site in `site/`.
   If yes:
   1. Check `node --version`. The site needs Node.js 26 or later (see `site/README.md`).
      - Missing or too old: read <https://nodejs.org/en/download>. Show the install command for the platform from step 0, and ask before you run it. After the install, run `node --version` again.
   2. Run `npm install` in `site/`.
   3. Ask if they want to verify the setup with `npm run check` and `npm test` in `site/`.
   Completion: `site/` dependencies are installed, or the user declined.

5. **Check `gh` (optional).**
   Run `gh --version`.
   - Missing: say that `gh` is optional but recommended for checking issues and opening pull requests. Ask if the user wants it. If yes, read <https://github.com/cli/cli#installation>, show the command for the platform from step 0, and ask before you run it.
   - Present: run `gh auth status`. If the user is not logged in, tell them to run `gh auth login` themselves (it is interactive).
   Completion: `gh` is installed and logged in, or the user declined.

6. **Summarize.**
   Give a short list of what is set up, and point to:
   - `CONTRIBUTING.MD` for editing committed folio files and making code contributions.
   - `site/README.md` for running the viewer locally (`npm run dev` in `site/`).
