# AI Coding Workspace

Build with the supplied local dependencies and run the Node tests from this directory.

```sh
node build.mjs
node --test test/*.test.js
```

Serve the generated files on the same origin as the Linux workspace API. The project picker lists the configured project roots and uses the fixed relative directory `.` to start at the selected root. Claude Code and Codex CLI are the agent IDs accepted by the session route. Recent sessions are kept in memory for the current page. The Resume session checkbox requests backend resume from a matching recent session.

Use `?mock=1` for the offline preview, including when opening `dist/index.html` directly. The app also uses the preview when the projects route returns HTTP 404. The preview includes sample tool steps, a mock approval and fixed terminal output.

Below 768px, Terminal starts collapsed and Open projects opens the sidebar. The live workspace API accepts text messages and tool decisions. File and image attachments and terminal output are available in the preview because the current workspace API has no routes for them. Live tool cards show their status and omit raw inputs and outputs, which may contain sensitive data.
