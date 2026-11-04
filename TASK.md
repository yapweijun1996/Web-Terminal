# Web Terminal Tasks

Last reviewed: 2026-11-04. This file is the authoritative project backlog. Tasks remain incomplete until their acceptance evidence is recorded. The running Mac implementation remains outside the repository; the in-repository development candidate is not automatically deployed. See [architecture](docs/architecture.md) for evidence and [operations](docs/operations.md) for verification and session-preservation requirements.

Status values: **Open** = not completed; **In progress** = actively being worked on; **Verified** = acceptance evidence recorded; **Blocked** = a specific prerequisite is unavailable. Priority describes order, not permission to change a live system. Record evidence, date, environment, and remaining limits when changing a status. A historical fixture result does not verify an unrelated live session.

## P0 — Access and safety

### WT-001: Verify the complete access boundary

- **Status:** Open
- **Scope:** Inventory the terminal HTTP, WebSocket, and upload routes and their actual Cloudflare Access policy and audience. Current inspected configuration is not end-to-end proof.
- **Acceptance:** An approved identity succeeds; unauthenticated and unauthorized identities are denied for each route. Test expiry and revocation separately for new connections and existing WebSockets; record actual behavior and any gap without exposing credentials.

## P1 — Foundation and core experience

### WT-002: Establish reviewable source and reproducible builds

- **Status:** In progress
- **Scope:** Inventory the separately maintained implementation and provenance; separate editable source from bundled or generated assets. Review what may be included before importing anything into the repository.
- **Evidence so far (2026-11-04):** The pinned unmodified upstream build matched the installed stock ttyd page byte-for-byte. A clean installation and two candidate builds produced the same output hash on this Mac. An isolated Chrome/tmux fixture created a window and retained a running fixture job through page reload. Local runtime socket and macOS upload baseline tests passed. See [source inventory](docs/source-inventory.md). Full live behavior parity, Linux reproducibility, other platforms, and deployment remain unverified.
- **Acceptance:** A clean checkout builds the reviewed artifact using documented dependencies and versions. An inventory and secret review exclude private configuration, credentials, uploads, logs, and terminal contents; compare the artifact in isolation before any deployment.

### WT-003: Diagnose Codex scrolling and expose scroll state

- **Status:** Open
- **Scope:** Reproduce the recorded issue in a disposable equivalent session, determine mouse and alternate-screen behavior, and evaluate clear terminal/application scroll state and a return-to-latest control where supported. Preserve unknown state when it cannot be determined.
- **Acceptance:** Document a reproducible cause or explicitly retain the unknown; verify any fix in shell, tmux copy mode, mouse-aware TUI, and the relevant Codex state. Do not modify drafts or submit commands. The original running pane is not considered fixed based on a separate fixture.

### WT-004: Make connection and recovery states clear

- **Status:** Open
- **Scope:** Design connected, reconnecting, offline, and reauthentication states, with explicit recovery failure and manual retry. Distinguish browser connection state from task state and preserve input where supported.
- **Acceptance:** Disconnect and reconnect an isolated fixture to the same job; verify unsent input and history and ensure no duplicate submission or automatic Enter. Clearly disclose when recovery cannot be established.

### WT-005: Improve workspace navigation

- **Status:** Open
- **Scope:** Evaluate named views, a clear active target, keyboard switching, focus, and explanatory feedback about closing a view versus ending a task. Preserve current session semantics.
- **Acceptance:** Navigate views by keyboard with visible focus and identifiable labels at narrow and desktop widths. Closing or switching a disposable view does not end an unrelated tmux job.

### WT-006: Bind upload completion to the intended view

- **Status:** Open
- **Scope:** First reproduce the hypothesis that changing views during an upload may change the insertion target. If confirmed, retain the original target and provide an explicit copy or retry path when it is unavailable.
- **Acceptance:** Tests for view switching, disconnect, and target loss never silently insert into a different view; a saved path remains available and no Enter is sent. A path alone is not evidence of an accepted CLI attachment.

### WT-007: Verify upload resource limits under interruption

- **Status:** Open
- **Scope:** Test the hypothesis that releasing the request concurrency count on response close can leave asynchronous processing running beyond the intended limit.
- **Acceptance:** Disposable interruption and timeout tests establish whether actual processing stays within the selected limit. Malformed and oversized images fail without uncontrolled work or unintended file changes.

## P2 — Usability and operational maturity

### WT-008: Add mobile terminal input controls

- **Status:** Open
- **Scope:** Design a collapsible input bar for Esc, Ctrl, Tab, and directional keys, with clear modifier state and space for the input line.
- **Acceptance:** On documented physical devices, touch controls work without accidental submission; with the soft keyboard open and closed, the terminal grid and PTY dimensions agree and the current input remains visible.

### WT-009: Improve keyboard and accessibility support

- **Status:** Open
- **Scope:** Provide keyboard-operable controls, visible focus, accessible names, connection announcements, and adjustable text and contrast. Treat screen-reader support for the terminal itself as a separate verification concern.
- **Acceptance:** Switching views and reconnecting work without a mouse; tested assistive technology identifies controls and relevant state changes. Record tested devices and untested limitations.

### WT-010: Provide a privacy-preserving status view

- **Status:** Open
- **Scope:** Show current view, connection state, and useful recovery information without claiming task health from process liveness.
- **Acceptance:** End-to-end status, component liveness, and unknown states are distinct; no tokens, commands, terminal contents, or personal filenames are exposed.

### WT-011: Verify resize, lifecycle, and platform support

- **Status:** Open
- **Scope:** Maintain an evidence-based matrix for browser/PTY dimensions, physical input, disconnect, sleep, logout, restart, and separately for Windows, WSL, and Xubuntu when available.
- **Acceptance:** Each tested case records environment, trigger, job outcome, and reconnect behavior; untested cases remain explicitly unknown. No survival through reboot or platform support is implied without evidence.

### WT-012: Assess dependency upgrades

- **Status:** Open
- **Scope:** Compare installed and candidate dependency versions and their configuration and path-handling behavior against vendor documentation before an upgrade.
- **Acceptance:** Record versions and relevant compatibility differences; test route protection and reconnect in isolation and prepare a verified rollback before any authorized live upgrade.

## Working order

Complete WT-001's access evidence and establish the isolated, reviewable foundation in WT-002. Reproduce WT-003, WT-006, and WT-007 with disposable fixtures before proposing behavioral changes. WT-004 and WT-005 can then be designed and tested against that foundation; prioritize P2 based on observed user needs. Live deployment and disruptive maintenance require their own authorization and rollback plan.
