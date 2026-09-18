# Leningrad Codex TEI

The Leningrad Codex encoded as a TEI document.

To get started with setting up the project locally, see the [Getting Started](#getting-started) section.

To learn more about this project and its goals, see the [About](#about) section.

## Getting Started

### Download

The entire document is available in the [/edition](./edition/) directory.

Every release also ships a zip of the complete document:

<https://github.com/charlesLoder/leningrad-codex-tei/releases/latest/download/leningrad-codex.zip>

### Installation

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

### Configuration

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

### Pipeline

Commands run in dependency order. Each one consumes the previous command's output:

```bash
uv run leningrad vendor-seed          # download and pin the seed mapping
uv run leningrad download-uxlc        # fetch and extract the UXLC book XMLs
uv run leningrad download-images      # fetch folio images from the source
uv run leningrad build-word-stream    # flatten the UXLC XML into a word stream
uv run leningrad align-folio          # align the text to the page layout
uv run leningrad download-batch       # poll and download a batch job's raw responses
uv run leningrad parse-raw           # parse downloaded raw responses (re-runnable after hand edits)
uv run leningrad validate             # cross-check the alignment records
uv run leningrad generate-tei         # emit per-folio TEI XML
uv run leningrad build-index          # compile index.xml
```

Pass `--help` to any command to see more information.

## About

The [Leningrad Codex](https://en.wikipedia.org/wiki/Leningrad_Codex) is oldest, complete manuscript of the Hebrew Bible.
Though many projects have sought to transcribe and encode the biblical text of the manuscript, few projects have encoded the layout.
This project emphasizes the codex not just as a text, but as an object.

The Text Encoding Initiative (TEI) provides the framework needed to encode the manuscript in a machine readable way using XML.
Recent advances in artificial intelligence combined with existing open data, provide a way to do this work at scale,
by utilizing multi-modal models to provide initial drafts of the columnar layout.

### Open Data

This project would not have been possible without existing open data.

The biblical text in the document was not transcribed directly from the images.
The text used is the Unicode/XML Leningrad Codex (UXLC) maintained by Christopher V. Kimball and accessible on the [tanach.us](https://www.tanach.us//Books/TEIHeaders/TanachHeader.TEI.html) site.
For this reason, the text in the edition may differ from the images in the manuscript.
That is an intentional choice.

The text determined to be on each folio was derived from Ben Denckla's index of the [Leningrad Codex](https://github.com/bdenckla/MAM-basics).

### Goals

The goals of this project are as follows:

- **Accessibility** — Make the Leningrad Codex available online as an open, TEI-encoded document, permissively licensed (MIT) and available through a web interface ([read more](#accessibility)).
- **Transparency** — Make transparent the process by which the document was generated, with special regard to how AI was utilized ([read more](#transparency)).
- **Reproducibility** — Make the results of the process reproducible ([read more](#reproducibility)).
- **Community** — Make this a community driven project ([read more](#community)).

### Accessibility

The primary aim of this project is to make the Leningrad Codex encoded as an TEI document freely available.

This is accomplished through:

- Permissive licensing (MIT)
- Public hosting of the repository on GitHub

Additional measures are taken to make this project accessible to scholars who may not be familiar or comfortable with the above:

- A quick [download link](#download) of the XML files
- An online viewer is available at https://leningrad-codex-tei.netlify.app

The code for the viewer is stored in `/site`.

### Transparency

Beyond making the document accessible, the project seeks to make the process of how the artifact was generated transparent.

This is accomplished through:

- The version control system (i.e. git)
- TEI headers
- Making the pipeline and prompts used available

#### AI Usage

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

### Reproducibility

This project also aims to make this work reproducible by providing the pipeline used to generate the document, with the realization that AI outputs are not always reproducible.

Future researchers can easily configure the pipeline to use different models, inference strategies, etc.

### Community

This project is not affiliated with any institution or organization.
It is intended to be a community driven endeavor.

See the [contributing guide](./CONTRIBUTING.MD) for more information.