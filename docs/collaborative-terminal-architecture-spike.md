# Collaborative terminal architecture spike

Status: **SPIKE_PARTIAL**. This is an isolated experiment, not a production design approval or a completed collaboration implementation. The required manager-independent real-process test has not run. No collaborative route is introduced.

## Decision under test

Evaluate a ttyd 1.7.7 watcher launched without `-W`, attached to the same disposable tmux pane that an authenticated writer changes through the existing `InputBroker` and `TerminalController`. Only a trusted server-side adapter may create broker connections and provide verified identities; the broker does not authenticate. Do not expose the tmux socket or a writable ttyd endpoint to a network watcher. Do not enable a collaborative route until the independent enforcement and attach-size tests pass and the remaining security boundaries are designed and tested.

Processes running as the same OS UID can access the tmux socket and bypass this broker. They belong to the trusted OS boundary in this experiment. A private Unix socket is not isolation between mutually untrusted same-UID processes or network principals. The test identity map is test-only and does not constitute network authentication.

## Alternatives

| Option | Benefits | Caveats |
| --- | --- | --- |
| Read-only ttyd plus broker writer | Existing output transport and guarded writer; backend, not UI, must enforce read-only. | ttyd attach and handshake may change shared pane size even if writes are rejected; test it. Requires authenticated routing, socket isolation, lifecycle management and a single deliberate sizing policy. Same-UID bypass remains. |
| Proxy filters ttyd protocol | Can centralize access and policy, potentially retain existing ttyd. | Proxy becomes a security boundary; must parse complete WebSocket/ttyd protocol, handle fragmentation, upgrades, version changes, malformed frames and backpressure fail-closed. A writable backend reachable around it defeats filtering; attach sizing still needs proof. |
| Broker-owned PTY | A single owner could mediate output, input and sizing and make policy explicit. | Larger architectural change: process lifecycle, terminal semantics, persistence/reconnect, fan-out, backpressure, tmux integration and recovery need design and independent testing. Same-UID/host boundaries still matter. |

The first option is a hypothesis for this spike, not an accepted production ADR. The other options have not been implemented or benchmarked.

## Existing code and evidence

`runtime/attach.sh` creates grouped tmux views and attaches them; `runtime/tmux.conf` configures mouse and status. The existing `tests/ttyd-protocol.test.js` tests writable `-W` input only. `runtime/gateway/broker.js` owns leases but trusts the caller's identity and executor; `mcp/input-gateway.js` wires it to `mcp/terminal.js`, which validates targets and executes guarded tmux commands. The spike uses those real modules, not a mock executor, with an isolated tmux server and a test-only in-memory identity map. It does not exercise the production attach script, network authentication, or browser routing.

On the Codex sandbox host, `node --check tests/spikes/collaborative-enforcement.js` passed; `node --test tests/input-broker.test.js` passed 3 tests. The new real-process script exited 2 before any enforcement assertion because its disposable tmux socket did not appear. An independent Node Unix socket bind returned `EPERM` in this sandbox. The owner reported that tmux and ttyd socket creation succeeded on the MBA-Terminal execution host; that preflight is not a result of this test and proves neither enforcement nor attach behavior.

## Independent execution and acceptance

From this exact worktree on the MBA-Terminal execution host, use `terminal_exec` to run:

```sh
node tests/spikes/collaborative-enforcement.js
```

Requirements: Node 22+, tmux 3.6a and ttyd 1.7.7 on PATH; local Unix socket creation permitted. The script creates a mode-700 private temporary directory, unique tmux server names, a read-only ttyd and a separate `-W` control fixture. It uses no existing tmux target. It destroys only its own sockets, ttyd child processes and named tmux servers. Do not run concurrently with an altered `TMUX_TMPDIR`-dependent test in the same Node process.

The script sends an actual masked WebSocket handshake and ttyd messages over a Unix socket. It independently checks visibility of broker-authorized text and Enter, refusal of a watcher broker claim, pane content/geometry/process invariance after input, Enter, bracketed paste, resize `1`, controls `2`/`3` and malformed messages, continued writer visibility, and a writable `-W` negative control in a separate fixture. Before/after attach dimensions are printed with intentionally different handshake dimensions. Any attach-time geometry change is a failing assertion; do not alter it to obtain a pass. An early fixture error exits 2, assertion failures exit 1, and all local assertions passing exits 0. The script's local pass is not the manager-independent acceptance itself: the manager must execute it and record full output, exit code, host versions and reviewed result. Only then can the manager consider `ARCHITECTURE_PROVED`, and only if every required invariant passed. If size changes, classify `ARCHITECTURE_BLOCKED` and retain the measured dimensions; if execution cannot reach all assertions, retain `SPIKE_PARTIAL`.

The stream assertion and denial assertion are separate. No mock-only test proves the security property. The test probes selected ttyd frames, not all possible protocol variants, identities, reconnect races, or production routing.

## Remaining P0/P1

- **P0:** Obtain independent actual output and exit status; watcher enforcement, negative-control sensitivity, and attach/resize impact are currently unknown.
- **P0:** MCP, upload and protected Access routes are outside this experiment and remain unsafe for collaboration; do not expose or claim them protected.
- **P0:** Implement and independently test real authentication, authorization, route/socket isolation, connection lifecycle and bypass resistance before deployment.
- **P1:** Define pane sizing ownership, reconnect/lease behavior, multiplexing and backpressure; test real `attach.sh` grouped views and real client behavior. Assess ttyd protocol/version drift and full malformed/fragmented message handling.
