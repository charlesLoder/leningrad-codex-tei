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

If using batch inference, check the status of the batch job using:

```bash
uv run leningrad download-batch
```

Then parse the downloaded raw responses with:

```bash
uv run leningrad parse-raw
```

If a folio fails to parse, fix `data/alignments/raw/<FOLIO>.xml` by hand and re-run `parse-raw --folio <FOLIO>`.

And then validate the output with:

```bash
uv run leningrad validate
```

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

### Generating the TEI document

The next step is to generate the TEI documents in `/edition`.

> [!NOTE]
> Contributor information at this step is derived from git's `user.name` and `user.email`. Update according to your preferences

Run the following to generate the XML files:

```bash
uv run leningrad generate-tei
```

And then update the index with:

```bash
uv run leningrad build-index
```

### Commit

Ensure everything looks correct and commit.

For version 1 of this project, AI should do the bulk of the work for alignment. 

## Creating a Pull Request

Create a pull request and link to the issues that need to be closed using a [keyword](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/using-keywords-in-issues-and-pull-requests).