# Leningrad Codex TEI

The Leningrad Codex (LC) encoded as a TEI document.

## Goals

- **Accessibility** — Make the Leningrad Codex available online as an open, TEI-encoded scholarly edition permissively licensed (MIT) and available through a web interface ([read more](#accessibility)).
- **Transparency** — Make transparent the process by which the artifact came to be, especially how AI was utilized ([read more](#transparency)).
- **Reproducibility** — Make the results of the process reproducible ([read more](#reproducibility)).
- **Community** — Make this a community driven project.

## Download

The full edition is generated into `edition/`.

For a ready-to-use bundle, every release ships a zip of the complete Codex:

<https://github.com/charlesLoder/leningrad-codex-tei/releases/latest/download/leningrad-codex.zip>

## Installation

Prerequisites:

- Python 3.11 or later
- [uv](https://docs.astral.sh/uv/)
- Node.js 18 or later (required for Hebrew text sequencing in `generate-tei`)
- [npm](https://docs.npmjs.com/) (ships with Node.js)

Clone the project:

```bash
git clone https://github.com/charlesLoder/leningrad-codex-tei
cd leningrad-codex-tei
```

From the project root:

```bash
uv sync
npm install
```

This will:
- create the virtual environment in `.venv/`
- install all dependencies (Python via `uv`, Node via `npm`)

The `leningrad` command-line tool becomes available via `uv run`:

```bash
uv run leningrad --help
```

## Configuration

All pipeline settings live in `config.yaml` at the project root.

To make local overrides without touching the committed defaults:

```bash
cp config.yaml config.local.yaml
uv run leningrad --config config.local.yaml <command>
```

Export your Gemini API key:

```bash
export GEMINI_API_KEY=<API_KEY>
```

## Pipeline

Commands run in dependency order. Each one consumes the previous command's output:

```bash
uv run leningrad vendor-seed          # download and pin the seed mapping
uv run leningrad download-uxlc        # fetch and extract the UXLC book XMLs
uv run leningrad download-images      # fetch folio images from the source
uv run leningrad build-word-stream    # flatten the UXLC XML into a word stream
uv run leningrad align-folio          # align the text to the page layout
uv run leningrad download-batch       # polls and download a batch job
uv run leningrad validate             # cross-check the alignment records
uv run leningrad generate-tei         # emit per-folio TEI XML
uv run leningrad build-index          # compile index.xml
```

Pass `--help` to any command to see more information.

## Accessibility

The primary aim of this project is to make the Leningrad Codex encoded as an EpiDoc (TEI) document freely available.

This is accomplished through:

- permissive licensing (MIT)
- public hosting of the repository on Github

Additional measures are taken to make this project accessible to scholars who may not be familiar or comfortable with the above:

- a quick [download link](#download) of the XML files
- an online viewer available at <LINK_TBD>

## Transparency

Beyond making the artifact (i.e. the LC as XML) accessible, the project seeks to make the process of how the artifact was generated transparent.

This is accomplished through:

- the version control system (i.e. git)
- TEI headers
- making the pipeline and prompts used available

### AI Usage

AI tools played an integral role in this project, being used for:

- generating the code in this repository
- aligning the biblical text to the columns and lines of a folio

The former is of little importance to the aims of this project, but a number of different models and strategies were employed in creating the code for the pipeline.

The latter is fully documented in a few different ways:

- The facsimile image used (URL and sha256) is documented in the TEI header `sourceDesc`, in a `graphic` element with an `idno` of type `sha256`.
- The model and parameters (temperature, inference mode, code execution, prompt version) are documented in the TEI header, in an `fs` of type `ai-params` inside the `revisionDesc` `change` for the alignment event.
- The repo hash is documented in the TEI header, allowing users to verify the prompt used, e.g. in folio 001B the repo hash is documented in the header, so users can examine the `ALIGN_PROMPT` at the same hash.

The project exclusively used Google's product offerings because the Gemini line of models:

- do well at image transcription
- are relatively cheap
- provide tools for code execution (see [Google's Agentic Vision](https://blog.google/innovation-and-ai/technology/developers-tools/agentic-vision-gemini-3-flash/))
- offer multiple inference options like batch or flex inference to save on costs

## Reproducibility

This projects also aims to make this work reproducible by providing the pipeline used to generate the document, with the realization that AI outputs are not always reproducible.

Future researchers can easily configure the pipeline to use different models, inference strategies, etc. to test

## Community

This project is not affiliated with any institution or organization. It is inteded to be a community driven endeavor.

See the [contributing guide](./CONTRIBUTING.MD) for more information.