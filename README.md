# Leningrad Codex TEI

The Leningrad Codex (LC) encoded as a TEI document.

## Goals

- **Accessibility** — Make the Leningrad Codex available online as an open, TEI-encoded document, permissively licensed (MIT) and available through a web interface ([read more](#accessibility)).
- **Transparency** — Make transparent the process by which the document was generated, with special regard to how AI was utilized ([read more](#transparency)).
- **Reproducibility** — Make the results of the process reproducible ([read more](#reproducibility)).
- **Community** — Make this a community driven project ([read more](#community)).

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

The primary aim of this project is to make the Leningrad Codex encoded as an TEI document freely available.

This is accomplished through:

- Permissive licensing (MIT)
- Public hosting of the repository on Github

Additional measures are taken to make this project accessible to scholars who may not be familiar or comfortable with the above:

- A quick [download link](#download) of the XML files
- An online viewer is available at https://leningrad-codex-tei.netlify.app

The code for the viewer is stored in `/site`.

## Transparency

Beyond making the document accessible, the project seeks to make the process of how the artifact was generated transparent.

This is accomplished through:

- The version control system (i.e. git)
- TEI headers
- Making the pipeline and prompts used available

### AI Usage

AI tools played an integral role in this project, being used for:

- Generating the code in this repository
- Aligning the biblical text to the columns and lines of a folio

The former is of little importance to the aims of this project, but a number of different models and strategies were employed in creating the code for the pipeline.

The latter is fully documented in a few different ways:

- The facsimile image used (URL and sha256) is documented in the TEI header.
- The model and parameters are documented in the TEI header.
- The prompt is linked to a commit sha.

The project exclusively used Google's product offerings because the Gemini line of models:

- Do well at image transcription
- Are relatively cheap
- Provide tools for code execution (see [Google's Agentic Vision](https://blog.google/innovation-and-ai/technology/developers-tools/agentic-vision-gemini-3-flash/))
- Offer multiple inference options like batch or flex inference to save on costs

## Reproducibility

This projects also aims to make this work reproducible by providing the pipeline used to generate the document, with the realization that AI outputs are not always reproducible.

Future researchers can easily configure the pipeline to use different models, inference strategies, etc.

## Community

This project is not affiliated with any institution or organization.
It is inteded to be a community driven endeavor.

See the [contributing guide](./CONTRIBUTING.MD) for more information.