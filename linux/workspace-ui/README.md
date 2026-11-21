# AI Coding Workspace

Build with the supplied local dependencies and run the Node tests from this directory.

```sh
node build.mjs
node --test test/*.test.js
```

Serve the generated files on the same origin as the Linux workspace API. Choose a configured project and one of its server-listed folders. Project root uses the relative directory `.`. Claude Code and Codex CLI are the agent IDs accepted by the session route.

Recent Sessions loads server history on startup and after each finished turn. Entries show the model and effort when recorded. Click an entry to resume it. The Resume session checkbox picks the latest entry for the selected project, folder, agent, and model when model options are available. Clear hides the current list until the next refresh.

The welcome card and composer show Model and Effort when the server provides options. A running turn locks both controls. Changing either setting between turns applies it on the next Send, which starts a new workspace session and can resume the CLI conversation if the model is unchanged. The browser remembers the last selection for each agent.

Assistant messages with thinking events show a collapsed Thinking row. Expand it to see any details supplied by the agent.

Use `?mock=1` for the offline preview, including when opening `dist/index.html` directly. The app also uses the preview when the projects route returns HTTP 404. The preview includes sample tool steps, a mock approval and fixed terminal output.

Below 768px, Terminal starts collapsed and Open projects opens the sidebar. The live workspace API accepts text messages and tool decisions. File and image attachments and terminal output are available in the preview because the current workspace API has no routes for them. Live tool cards show their status and omit raw inputs and outputs, which may contain sensitive data.

Press Enter to send a message and Shift+Enter to insert a newline. If the server is still stopping the previous run, Retry repeats the failed action.
