# Mobile context paste

## User flow

Open **Paste context** from the toolbar (under the actions menu on narrow screens).
The plain multiline editor keeps the draft in page memory. It does not read the
clipboard until **Read clipboard** is clicked. If permission is denied or the API
is unavailable, tap/long-press the editor or use the keyboard clipboard. Editor
Enter inserts a newline; IME composition never submits to the terminal.

For multiline context, explicitly choose **Create context file**. The generated
private text file lasts one hour and can be removed early with **Delete file**.
Copy its path, or **Confirm target**, then **Insert file path**. Ask the AI to read
that path using its normal file-reading workflow; no CLI-specific `@file` syntax
is assumed. Creating a file sends no terminal input. The file is a snapshot of
the draft at creation: delete and recreate it to update its content.

Single-line text can instead use **Confirm target**, then **Insert single line**.
Insertion never adds Enter. Inspect the terminal and press Enter separately if
appropriate. Multiline text and control characters are rejected entirely by
terminal insertion; bracketed paste cannot guarantee that an application will
not execute embedded newlines. This feature never sends raw multiline input.

Inserting pauses managed MCP writers in every terminal and drains in-flight
writes first. Running Codex/Pi processes continue running. **Resume sharing**
explicitly resumes AI input in the selected terminal with a fresh generation.
After a UI/coordinator restart, managed AI starts paused until the owner resumes;
a restart must not silently erase a prior human takeover.

## Authority and targeting

Every context API mutation requires the real signed owner identity, exact Origin
and the existing CSRF request token. This does not change MCP authorization,
its 8192-byte single-line bound, or grant/resource/PKCE/redirect settings.

Opening the editor captures authoritative server/session/window/pane and pane
process identities plus the attached-client session mapping. Browser titles are
only hints checked against that server capture. A confirmation binds purpose,
SHA256, UTF-8 bytes and verified owner to this immutable initial capture. Opening
captures last ten minutes; an insertion confirmation lasts sixty seconds. Edits
invalidate local confirmation. **Refresh target** explicitly recaptures the
current view while retaining the draft. Native switching, disconnection, pane
selection/respawn, expired identity/receipt, and unknown drain outcomes reject
insertion. The final tmux command checks identities, process, active pane, live
mode, and actual client-session mapping in its own command queue. No current-client
`term.paste` fallback exists.

Receipts are consumed before awaiting insertion, and requests time out after ten
seconds without automatic retries. Unconfirmed delivery disables further insert
attempts until the user inspects the terminal and explicitly reopens/recaptures.
Cancel closes the editor without terminal input and retains the memory draft.
Reload/navigation loses unsaved drafts; nothing is persisted in localStorage.

## Private files and limits

Context files allow ordinary LF/CRLF and tabs; NUL/ESC/other controls are rejected
rather than stripped. Maximum content is 65536 UTF-8 bytes, checked before any
write; no truncation. Server-generated random filenames use exclusive/no-follow
creation, mode0600 inside a checked owned0700 directory. Maximum100 managed files
(about6.5MiB). Cleanup removes expired exact random text filenames only, including
old process orphans, and never recursively deletes arbitrary paths or follows
symlinks. Same OS account access remains trusted; file modes are not per-agent
isolation. Drafts, file content, credentials and request bodies are never logged.
The runtime's contexts directory is the default; deployment may choose an
explicit private `TERMINAL_CONTEXT_DIR`.

## Verification and rollout

Use only disposable isolated tmux fixtures. `node --test linux/test/*.test.js`
includes owner/Origin/CSRF denial, digest/purpose/byte binding, replay/double click,
whole-input rejection, no Enter, stale selection/process/native switch,
expiry during drain, owner expiry, symlink/collision, file expiry/orphan cleanup,
global pause and explicit Resume, and fail-closed coordinator bootstrap.

Run real Chromium against signed-owner fullstack fixtures:

```
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node linux/test/context-paste-browser.e2e.cjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node linux/test/collaboration-browser.e2e.cjs
```

The context runner checks explicit clipboard reads, denial fallback, composition,
draft retention through rotation/Cancel, UTF-8 limits, private file/path transfer,
once-only literal input, owner pause, stale target changes, and desktop/mobile/
reduced-height geometry. These are browser emulation results, not physical iOS
Safari or Android/Gboard verification; those devices remain NOT RUN.

Independent security and UX review must close observed high-impact issues before
publication. Package/canary from the exact merged revision, back up the precise UI
unit override, verify `KillMode=process` and empty stop hooks, and restart only UI.
Preserve OAuth/MCP services, tunnel, base terminal and all existing pane process
identities. Root release owner records actual pushed/deployed SHA, readiness,
public routes, served asset identity and rollback in local release artifacts.
No fixture owner identity, new production grant or existing terminal content is
used for live feature tests.

After this UI upgrade, refresh the Web Terminal page once to load the editor.
Existing managed sessions remain paused; choose Resume sharing only when you
want AI input enabled for that terminal. No production Resume is automated.

## Local implementation checkpoint

The isolated implementation run passed Linux103/103 (including eight context
cases), input-broker3/3, MCP104/104 with31 existing Darwin-only skips, and OAuth40/40;
all test commands exited0. Both actual Chromium context and collaborative-input
runners exited0 against disposable signed-owner fullstack fixtures. Independent
security/UX review and root release acceptance are recorded separately; these
local results do not claim physical-device or production-owner browser acceptance.
