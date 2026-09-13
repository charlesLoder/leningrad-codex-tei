# Contributing

Because this project is not affiliated with any institution or organization, it relies on community involvement.

## Aligning folios

The greatest bottleneck to this project is the cost of inference for aligning folios via AI.
This project seeks to mitigate that by asking contributors run inference for folios that are not completed.

### Installation

To get started, follow the installation steps in the [README](./README.md#installation).

### Incomplete folios

To see which folios are incomplete, view open issues on the issue board tagged with `folio`.

TODO: add link

Tag me in which folios you would like to do, and I will assign the issue to you.

It will be simplest to run inference on a contiguous set of folios.

### Configuration

Though much of the project can be configured, for the initial version, it will be best to use the defaults.

### Initial step

Run the following parts of the pipeline before running inference:

```bash
uv run leningrad vendor-seed
uv run leningrad download-uxlc
uv run leningrad download-images
uv run leningrad build-word-stream
```

### Running inference

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

## Creating a Pull Request

Create a pull request and link to the issues that need to be closed using a [keyword](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/using-keywords-in-issues-and-pull-requests).