---
name: documentation-review
description: When changing project code, check existing README.md, AGENTS.md, CONTEXT.md, and ADR files for consistency; report findings and update documentation only when asked.
---

# Documentation Review

Use this skill when implementing or changing project code, and when the user asks for a documentation review. Check repository instructions that govern the work, then inspect relevant documentation files that exist: `README.md`, `AGENTS.md`, `CONTEXT.md`, and architecture decision records (ADRs, commonly under `adr/` or `docs/adr/`). Check other docs only when the code change touches behavior they describe.

## Review before changes

- Identify documentation that describes the changed behavior, commands, configuration, interfaces, architecture, or constraints.
- Compare those claims with the planned or current code changes. Check for missing coverage, stale examples or paths, incorrect commands, and conflicts across documents and ADRs.
- Prepare a concise report with affected documents, findings, evidence, and recommended changes.
- Do not edit documentation unless the user explicitly requests documentation updates. Code-change authorization alone does not authorize doc edits.

## After requested documentation updates

Update only the documentation scope the user authorized. Then recheck the updated statements against the resulting code and compare affected documents with each other. Report what was updated, what was rechecked, and any remaining mismatch or unverified claim. Do not claim commands or behavior were verified unless they were actually checked.

If a referenced documentation file is absent, report that fact when it matters to the change; do not create one unless the user asks.
