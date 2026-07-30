---
description: Scaffolds a BGH-style commit message for VITAL_Services changes.
---

# git-commits skill

Use this skill to produce a commit message that matches `.agents/rules/git-commits.md`.

## Required inputs

- **type**: feat | fix | chore | docs | refactor | test | style | perf | ci | revert
- **scope**: a short slug for the area touched (e.g. `vital`, `appointment`, `telemedicine`, `internal`, `gateway`, `audit`)
- **summary**: past-tense, < 70 chars
- **ticket**: VITAL-M{n}-F{n}
- **changed paths**: repo-relative

## Output template

```
<type>(<scope>): <summary> [<ticket>]

- <bullet 1, references repo-relative path>
- <bullet 2>
- <bullet 3>
```
