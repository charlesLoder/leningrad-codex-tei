---
name: bump-version
description: Bump the edition version, tag it, and push the release.
disable-model-invocation: true
---

# Bump Version

Bump the edition version in `pyproject.toml`, tag it, and push.
Single source of truth is `[project].version` in root `pyproject.toml`
(bare semver, e.g. `0.2.4`). The git tag must equal `v<version>`
(e.g. `v0.2.4`); the `deploy-viewer` and `release-bundle` workflows
fail when the tag and the file differ.
Do not bump `site/package.json`; that viewer app version is separate.

## Steps

1. **Find the last release and check folio changes.**
   `git tag --sort=-v:refname | head -1` gives `$LAST` (e.g. `v0.2.4`).
   Then:
   `git diff --name-only $LAST..HEAD -- edition/`
   Completion: the list holds at least one folio side
   (`edition/NNN{A|B}.xml`); with no folio change, stop and report
   an empty release instead of bumping.

2. **Check the index is current, rebuild when stale.**
   When step 1 shows folio changes but no `edition/index.xml` change,
   run `uv run leningrad build-index`.
   Then `git status --short -- edition/index.xml`.
   When the index changed, commit it alone:
   `git add edition/index.xml && git commit -m "update index"`
   Completion: `edition/index.xml` holds all folio sides from step 1,
   and the working tree is clean for `edition/`.

3. **Bump the version.**
   When the user already named `major`, `minor`, or `patch`, use it.
   Else ask the user which part to bump and wait for the answer.
   Run `uv version --bump <part>`.
   Read the new bare version with `uv version --short`.
   Completion: `pyproject.toml` holds the new bare version.

4. **Commit the bump.**
   `git add pyproject.toml uv.lock`
   `git commit -m "version bump v<X.Y.Z>"`
   (always with the `v` prefix, e.g. `version bump v0.2.5`).
   Completion: `git show HEAD --stat` lists only `pyproject.toml`
   and `uv.lock`.

5. **Tag the release.**
   `git tag v<X.Y.Z>` with the same bare version as step 3.
   Then check the tag matches the file:
   `git tag --list "v*" | tail -5` plus
   `grep -m1 '^version = ' pyproject.toml`.
   Completion: tag `v<X.Y.Z>` exists and equals `v` + file version.

6. **Stop for user check. Always.**
   Show `git log --oneline $LAST..HEAD`, `git status`,
   `git show HEAD --stat`, and the new tag.
   Ask the user to confirm. Push only after an explicit yes.
   Completion: the user said yes or said stop.

7. **Push branch and tag.**
   `git push origin <branch>` then `git push origin v<X.Y.Z>`.
   Completion: both the branch and the tag exist on `origin`.
