---
name: git-commits
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


## Sprint source

Consult the root `docs/backlogs/UHSE_Sprint_Backlogs_Commit_Reference.md` for Sprint 0–8 relationships. Use an approved local VITAL feature ticket when available; VITAL-M0-F0 is general maintenance, not a substitute for a known feature. Do not invent a VITAL feature number from a UHSE module or convert independent namespaces by replacing a prefix. PR metadata uses an explicit unified workbook counterpart only when behavior matches; otherwise retain the qualified local code. Retired EDA engineering labels are not current aliases. Tests absent from the sheet remain valid developer coverage; sheet matches follow the separate QA detail links.
