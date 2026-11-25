# Contributing

Because this project is not affiliated with any institution or organization, it relies on community involvement.

With the completion of v1.0.0, using AI to align folios is no longer the most important way to contribute.

Open issues can be found at: https://github.com/charlesLoder/leningrad-codex-tei/issues

## Prereqs

Prerequisites:

- Python 3.11 or later
- [uv](https://docs.astral.sh/uv/)

The `gh` cli is not required but is extremely helpful and recommended, especially for agentic work.

## Getting Started

After you clone the project, an agent (e.g. Claude Code) can do the setup with you.
Open the agent in the project root and run the `/getting-started` skill.
The steps below do the same work by hand.

### Installation

Clone the project:

```bash
git clone https://github.com/charlesLoder/leningrad-codex-tei
cd leningrad-codex-tei
```

From the project root:

```bash
uv sync
```

This will create the virtual environment in `.venv/`

The `leningrad` command-line tool becomes available via `uv run`:

```bash
uv run leningrad --help
```

For setting up the site, see the [README there](site/README.md).

### Windows

Git checks out symlinks as plain text files unless symlink support is enabled.
On Windows without symlink support, `.claude/skills` is a plain text file, so Claude Code does not find the repo skills.

The simplest fix is to use `.agents/skills/` directly. Delete the `.claude/skills` file, then copy the folder:

```powershell
Remove-Item .claude\skills
Copy-Item -Recurse .agents\skills .claude\skills
```

Do not commit this change. If you edit a skill, edit it in `.agents/skills/`.

Alternatively, enable Developer Mode (or run as administrator), then clone with symlinks turned on:

```bash
git clone -c core.symlinks=true https://github.com/charlesLoder/leningrad-codex-tei
```

For an existing clone, run `git config core.symlinks true`, delete the `.claude/skills` file, and then run `git checkout -- .claude/skills`.

## Editing committed folio files

The files in `/edition` are the source of truth, not the pipeline.
Hand edits (by a person or an agent) are made directly to those files.

Record each hand edit in the folio's `revisionDesc`.

Agents can use the `/update-revisiondesc` skill.

## Code Contributions

Project instructions for AI coding agents live in [AGENTS.md](./AGENTS.md).

Agent skills live in `.agents/skills/`. For tools that read skills from `.claude/skills/` (e.g. Claude Code), that path is a symlink to `.agents/skills/`, so both share the same skills. For Windows setup, see [Windows](#windows).
