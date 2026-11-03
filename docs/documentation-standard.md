# Documentation standard

Keep project documentation in English, concise, and consistent with the actual repository and verified runtime. State the date and source for observations that can become stale. Label historical evidence, proposals, assumptions, and unknowns; do not present a fixture result as proof for another device, session, or deployment.

## Document ownership

| Document | Purpose and authoritative content |
| --- | --- |
| [README](../README.md) | Project entry point, repository scope, current limitations, and document links. |
| [TASK](../TASK.md) | Single backlog for task IDs, priority, status, scope, acceptance, dependencies, and completion evidence. |
| [Architecture](architecture.md) | Observed implementation, trust boundaries, and source-of-truth boundaries. |
| [Operations](operations.md) | Safe investigation, verification, and rollback procedures. |
| [Roadmap and research](improvement-roadmap.md) | Research rationale, source links, and sequencing; link to TASK for current task details rather than maintaining a second backlog. |

## When updating

1. Read the affected source and current task evidence first. Do not infer live behavior from an old note or a successful process check.
2. Update the owning document and affected links together. When behavior or architecture changes, update the relevant architecture or operations description and any affected task status.
3. Give completed tasks dated, inspectable acceptance evidence and disclose untested platforms or remaining gaps. Use **Verified** only after the relevant checks pass; deployment is a separate fact.
4. Keep credentials, tokens, private host configuration, terminal contents, uploaded files, logs, and personal filenames out of the repository. Review changes before committing or publishing.
5. Check Markdown links, headings, whitespace, and consistency. Do not claim a build or runtime test ran when only documentation was checked.

The KB-MCP `cloudflare-web-terminal` Skill owns the reusable operating procedure. This repository owns project-specific documentation and backlog; neither replaces current configuration or grants permission to change a live system.
