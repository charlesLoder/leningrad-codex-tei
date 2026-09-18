---
name: folio-pr
description: Ship committed folio TEI documents as a PR that closes each folio issue.
disable-model-invocation: true
---

# Folio PR

Ship a branch of committed folio sides as one pull request that closes each folio's issue.

Use the repo glossary in `AGENTS.md`: a **folio side** is `Fxxx{A|B}`, one TEI document per side under `edition/`.

## Steps

1. **Collect the committed folio sides.**
   Run against the current branch:
   `git show --name-only --pretty=format: HEAD | grep -oE '[0-9]{3}[AB]' | sort`
   For a multi-commit branch, prefer:
   `git diff --name-only origin/main...HEAD -- edition/`
   Completion: every `edition/XXXX.xml` side on the branch is listed, sorted, with no extras.

2. **Resolve each side to its issue number.**
   For each side `$FOLIO` (e.g. `001B`), run:
   `gh issue list --search "$FOLIO in:title" --json number,title --limit 5`
   Expect exactly one hit of the form `Folio XXXX: create TEI document`.
   Completion: every side has exactly one `#N`; any `NOT FOUND` or duplicate is reported before continuing.

3. **Push the branch.**
   `git push -u origin <branch>`
   Completion: the branch tracks `origin/<branch>`.

4. **Build the PR body.**
   First line names the range, then one `Closes #N` line per issue in folio order, e.g.:
   `Adds TEI documents for folios 001B through 038A.`
   Completion: the body holds one `Closes` line per side, in the same order as step 1.

5. **Create the PR and verify.**
   `gh pr create --base main --head <branch> --title "Add folios <FIRST> to <LAST>" --body-file <file>`
   Then `gh pr view <number> --json number,title,url,baseRefName,headRefName` to confirm base `main`, head, title, and body.
   Completion: the PR URL is returned and its body carries every `Closes #N`.
