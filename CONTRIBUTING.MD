# Contributing

Because this project is not affiliated with any institution or organization, it relies on community involvement.

The most needed way to contribute is aligning folios. Contributions to the code and checks against folios that have been aligned are welcome as well.

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
On Windows without symlink support, `.claude/skills` is a plain text file, so Claude Code does not find the repo skills (such as `/align-folio`).

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

### Configuration

All pipeline settings live in `config.yaml` at the project root.

To make local overrides without touching the committed defaults:

```bash
cp config.yaml config.local.yaml
uv run leningrad --config config.local.yaml <command>
```

### Pipeline

Each group builds on the one before it. Use either 2a or 2b.

**Group 1:** Commands used for pulling data:

```bash
uv run leningrad vendor-seed          # download and pin the seed mapping
uv run leningrad download-uxlc        # fetch and extract the UXLC book XMLs
uv run leningrad download-images      # fetch folio images from the source
uv run leningrad build-word-stream    # flatten the UXLC XML into a word stream
```

**Group 2a:** Commands used for aligning folios with Gemini:

```bash
uv run leningrad align-folio          # align the text to the page layout
uv run leningrad download-batch       # poll and download a batch job's raw responses
```

**Group 2b:** Commands used for aligning folios with a harness:

```bash
uv run leningrad prepare-folio        # write task packets for an agent harness (no model call)
uv run leningrad check-reply          # parse and validate a harness reply without writing anything
uv run leningrad ingest-folio         # verify a harness run against its packet and save it as a raw reply
```

These commands are run by the agent via the `/align-folio` skill.

**Group 3:** Commands used for parsing output:

```bash
uv run leningrad parse-raw            # parse downloaded raw responses (re-runnable after hand edits)
```

Used after either the Gemini or harness path. The `/align-folio` skill runs `parse-raw`.

**Group 4:** Commands used for validating output:

```bash
uv run leningrad validate             # cross-check the alignment records
```

The `/align-folio` skill runs `validate`

**Group 5:** Commands used for generating XML artifacts:

```bash
uv run leningrad generate-tei         # emit per-folio TEI XML
uv run leningrad build-index          # compile index.xml
```

Pass `--help` to any command to see more information.

## Aligning folios

The greatest bottleneck to this project is the cost of inference for aligning folios via AI.
This project seeks to mitigate that by asking contributors run inference for folios that are not completed.

### Goals

The main goal of aligning the folios for v1.0.0 (issues pulled from the `/find-folios` skill will have this label) is to encode the columnar layout of the biblical text.

It does not have to be perfect nor exhaustive, but it should be complete.

For that reason, some parts of a folio are not encoded, such as deletions or erasures.
Where the codex has these, they may be encoded in a low-fidelity way (for example, as a blank line).

### Incomplete folios

To see which folios are incomplete, view [open issues tagged with `folio`](https://github.com/charlesLoder/leningrad-codex-tei/issues?q=is%3Aissue+state%3Aopen+label%3Afolio+sort%3Acreated-asc).

Folio issue titles all follow the same format: `Folio <FOLIO>: create TEI document`.

To claim a folio, comment `/claim` on its issue. A workflow assigns the issue to you.
It will not assign an issue that someone else holds, and one person can hold at most 10 open folio issues.
To give an issue back, comment `/unclaim`.

Agents can do this programmatically using the `gh` cli.

Two skills help with this:

- `/find-folios` asks how many folios you want. It lists that many open, unassigned folio issues, and (after you agree) comments `/claim` on each, then reports which ones you got.
- `/my-folios` lists the open folio issues assigned to you, and offers to align them.

It will be simplest to run inference on a contiguous set of folios.

### Initial step

Run the pulling-data commands from [pipeline](#pipeline).

#### UXLC version

The edition is made from UXLC 2.5 (build 27.6).
[tanach.us](https://www.tanach.us) serves only the current UXLC release, so `download-uxlc` gets UXLC 2.5 from a mirror on this repo's [`uxlc-mirror`](https://github.com/charlesLoder/leningrad-codex-tei/tree/uxlc-mirror) branch.
Do not change `uxlc.download_url` in `config.yaml`.

`download-uxlc` and `build-word-stream` compare the UXLC version with the version in the folio headers in `/edition`.
If the versions are different, the command stops and does not write files.
If you see this error, you may have UXLC from tanach.us in `data/uxlc/` (e.g. from an earlier download).
Run `download-uxlc` with the default config, then run `build-word-stream` again.

### Running inference

#### Gemini

Obtain a [Gemini API Key](https://ai.google.dev/gemini-api/docs/api-key) and add it to your environment

```bash
export GEMINI_API_KEY=<API_KEY>
```

Align the folios using:

```bash
uv run leningrad align-folio --folio <FOLIO> --limit <LIMIT>
```

Where `<FOLIO>` is the first folio you are assigned and `<LIMIT>` is the number of following including the first you will do.

For example, doing the first 10 folios would be:

```bash
uv run leningrad align-folio --folio 001B --limit 10
```

If using batch inference, check the status of the batch job using:

```bash
uv run leningrad download-batch
```

Then parse the downloaded raw responses with:

```bash
uv run leningrad parse-raw --start-folio <FOLIO>
```

If a folio fails to parse, fix `data/alignments/raw/<FOLIO>.xml` by hand and re-run `parse-raw --folio <FOLIO>`.

And then validate the output with:

```bash
uv run leningrad validate --start-folio <FOLIO>
```

Agents can use `/view-batch-result` to analyze batch results.

#### Agent Harness

Though this pipeline was created with Gemini in mind, any agent (e.g. Claude Code) can be used.

Ensure everything in [the initial step](#initial-step) has been done first.

Agents have access to the `/align-folio` skill.

Example:

```bash
claude -p "/align-folio <FOLIO>"
```

### Validating model outputs

The pipeline attempts to provide some level of determinism and validation, but it is unable to determine if the model's output is correct.

Generally, models handle the task well.

Agents should report and summarize model output in two levels:

- **Needs human review**: items the model could not decide with high confidence (for example, a column with more or fewer lines than the others, or badly damaged text).
- **Review notes**: decisions the model made that do not need a check (for example, a blank line that stands for an erasure).

`/folio-pr` puts both levels in the pull request body.

You do not need to resolve every item that needs human review yourself.
If you cannot check an item (for example, you do not read Hebrew), leave it in the pull request body for the maintainer.
The maintainer checks these items before the pull request is merged.

### Handling errors with inference output

Errors can occur in multiple places. Here are some encountered scenarios and how to fix them.

#### Model gave an incorrect output

Models make mistakes.

After a raw model response in stored, run the `parse-raw` command.
If an error occurs, the command will tell you where (e.g. 3:1 is column 3, line 1).
A common error is text from the the gutters being added.
Open up `{config.paths.alignments}/raw/{folio}.xml` and make adjustments where needed.

Rerun the `parse-raw` command to validate the fix.

#### Incorrect upstream data

The upstream data can be incorrect.

For example, according to the seed file, the last word on 027B was incorrectly labeled as the first word of Genesis 44:23, and the first word on 027A wasincorrectly labeled as the second word of Genesis 44:23.

In that instance, the seed file had to be modified

```diff
{
    "page": "027B",
    "startco": null,
    "startli": null,
    "stopco": null,
    "stopli": null,
    "bkid": "Genesis",
    "startc": 43,
    "startv": 32,
    "startp": 14,
    "stopc": 44,
    "stopv": 23,
-    "stopp": 1,
+    "stopp": 2,
    "note": null
},
{
    "page": "028A",
    "startco": null,
    "startli": null,
    "stopco": null,
    "stopli": null,
    "bkid": "Genesis",
    "startc": 44,
    "startv": 23,
-    "startp": 2,
+    "startp": 3,
    "stopc": 45,
    "stopv": 16,
    "stopp": 13,
    "note": null
},
```

##### Reporting seed boundary errors

Most contributors cannot open issues on the upstream repo (`bdenckla/MAM-basics`).
So, after you fix the seed file (you or an agent can make the fix), report the error as a comment on [issue #1076](https://github.com/charlesLoder/leningrad-codex-tei/issues/1076).
The maintainer passes the reports upstream.

Check the comments on the issue first. Do not post a case that is already there.

Give these details:

- The pages (e.g. `124B / 125A`) and the verse (e.g. Josh 7:12)
- The seed values now and the values they should be (`stopp` and `startp`)
- What the images show on each page (the last words of the first page and the first words of the second page)
- The pull request that uses the fixed boundary

Also list the error in the pull request body as an item for human review.
If you use an agent, it gives you the path of the image file on disk, so you can check the boundary yourself.

If you use the `gh` cli:

```bash
gh issue comment 1076 --repo charlesLoder/leningrad-codex-tei --body-file <FILE>
```

### Generating the TEI document

The next step is to generate the TEI documents in `/edition`.

> [!NOTE]
> Contributor information at this step is derived from git's `user.name` and `user.email`. Update according to your preferences

Run the following to generate the XML files:

```bash
uv run leningrad generate-tei --start-folio <FOLIO>
```

And then update the index with:

```bash
uv run leningrad build-index
```

### Commit

Ensure everything looks correct and commit.

For version 1 of this project, AI should do the bulk of the work for alignment. 

Agents can use the `/commit-folios` skill. It makes a working branch if you are on `main`, runs `validate`, generates the TEI files one folio at a time with `--folio`, formats, and commits.

### Creating a Pull Request

Create a pull request and link to the issues that need to be closed using a [keyword](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/using-keywords-in-issues-and-pull-requests).

**Prefer one pull request for a contiguous range of folio sides** (for example, `101B` to `106A`) over one pull request per folio side.
Use one `Closes #N` line for each folio side in the pull request.
If you already have several open single-folio pull requests, combine them into a range pull request.

Agents can use the `/folio-pr` skill. If you do not have write access to this repo, it pushes to your fork and opens the pull request from there. It asks before it pushes and before it creates the pull request.

### Skill workflow

The agent skills hand off to each other in this order:

1. `/getting-started`: set up the clone.
2. `/find-folios` or `/my-folios`: claim folios, or see the ones you have.
3. `/align-folio`: align one folio side (`/my-folios` runs one subagent per folio). It reports the review notes.
4. `/commit-folios`: generate the TEI files and commit them.
5. `/folio-pr`: open the pull request that closes the folio issues. It includes the review notes in the pull request body.

## Editing committed folio files

Once a folio is in `/edition`, the file there is the source of truth, not the pipeline.
Hand edits (by a person or an agent) are made directly to those files.

> [!WARNING]
> `generate-tei` rewrites a file from the alignment data and drops any hand edits, including entries in the `revisionDesc`.
> Only run it for new folios, using `--folio` or `--start-folio`. Never run it without either.

Record each hand edit in the folio's `revisionDesc`.

Agents can use the `/update-revisiondesc` skill.

### Adding verse zones

Verse zones show where each verse is on the facsimile image.
They come from the [Masoretica](https://www.masoretica.org) HTR of the codex by Idan Dershowitz.

Zones are not part of the pipeline.
Treat them as a hand edit to a committed folio file: run the commands below on the folios you work on, then commit the result.
The command edits each file in place, so other hand edits stay.

```bash
uv run python scripts/zones.py download --folio 001B   # omit --folio for all edition folios
uv run python scripts/zones.py add --folio 001B --dry-run
uv run python scripts/zones.py add --folio 001B
```

The `add` command does these steps:

- It removes the rects in the top and bottom margins. The HTR also finds verse words that the masora quotes there.
- It trusts the Masoretica data: it does not compare the zones with the columns and lines of the folio. A verse with no verse milestone on the folio gets no zone, and the command prints the verse.
- It adds the Archive.org image (the zones use its pixels), the zones, a `facs` on each verse milestone, a `respStmt` for Masoretica, and a `<change>`.

When you run it again with the same data, it does not change the file.
`generate-tei` does not keep the zones. If you must regenerate a folio, run `add` for it again.

## Code Contributions

Project instructions for AI coding agents live in [AGENTS.md](./AGENTS.md).

Agent skills live in `.agents/skills/`. For tools that read skills from `.claude/skills/` (e.g. Claude Code), that path is a symlink to `.agents/skills/`, so both share the same skills. For Windows setup, see [Windows](#windows).
