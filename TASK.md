# Web Terminal Tasks

Last reviewed: 2026-11-04. This file is the authoritative project backlog. Status and evidence are scoped to the implementation and environment stated. The repository includes a Linux source snapshot and a reconstructed Mac development candidate; neither is automatically deployed to the separately maintained live systems. See [architecture](docs/architecture.md), [Linux evidence](docs/linux-implementation.md), and [Mac evidence](docs/source-inventory.md) for boundaries and [operations](docs/operations.md) for session-preservation requirements.

Status values: **Open** = not completed; **In progress** = actively being worked on; **Verified** = acceptance evidence recorded; **Blocked** = a specific prerequisite is unavailable. Priority describes order, not permission to change a live system. Record evidence, date, environment, and remaining limits when changing a status. A historical fixture result does not verify an unrelated live session.

## P0 — Access and safety

### WT-001: Verify the complete access boundary

- **Status:** Open
- **Scope:** Inventory the terminal HTTP, WebSocket, and upload routes and their actual Cloudflare Access policy and audience. Current inspected configuration is not end-to-end proof.
- **Acceptance:** An approved identity succeeds; unauthenticated and unauthorized identities are denied for each route. Test expiry and revocation separately for new connections and existing WebSockets; record actual behavior and any gap without exposing credentials.

## P1 — Foundation and core experience

### WT-002: Establish reviewable source and reproducible builds

- **Status:** Verified
- **Scope:** Inventory the separately maintained implementations and provenance; separate editable source from bundled or generated assets. Both a Linux snapshot and a reconstructed Mac development candidate are present.
- **Acceptance:** A clean checkout builds the reviewed artifact using documented dependencies and versions. An inventory and secret review exclude private configuration, credentials, uploads, logs, and terminal contents; compare the artifact in isolation before any deployment.
- **Linux evidence (2026-11-04):** The imported source is editable and ttyd supplies its embedded client at runtime. The pinned ARM64 Alpine fixture builds from the repository and passed `node --test` with a disposable tmux server and Unix sockets; see [Linux evidence](docs/linux-implementation.md). Its ttyd and tmux versions differ from those observed on the Ubuntu host, and registry availability is not guaranteed.
- **Mac evidence (2026-11-04):** The pinned unmodified upstream build matched the installed stock ttyd page byte-for-byte. A clean installation and two candidate builds produced the same output hash on this Mac. An isolated Chrome/tmux fixture created a window and retained a running fixture job through page reload. Local runtime socket and macOS upload baseline tests passed. See [Mac source inventory](docs/source-inventory.md). Full live behavior parity, other platforms, and deployment remain unverified.

### WT-003: Diagnose Codex scrolling and expose scroll state

- **Status:** Open
- **Scope:** Reproduce the recorded issue in a disposable equivalent session, determine mouse and alternate-screen behavior, and evaluate clear terminal/application scroll state and a return-to-latest control where supported. Preserve unknown state when it cannot be determined.
- **Acceptance:** Document a reproducible cause or explicitly retain the unknown; verify any fix in shell, tmux copy mode, mouse-aware TUI, and the relevant Codex state. Do not modify drafts or submit commands. The original running pane is not considered fixed based on a separate fixture.
- **Evidence:** A 2026-11-04 Linux Chromium fixture exercised wheel scrollback, return to latest and `less --mouse`; it did not test the original Mac Codex pane, physical trackpad or mobile touch.

### WT-004: Make connection and recovery states clear

- **Status:** Verified
- **Scope:** Design connected, reconnecting, offline, and reauthentication states, with explicit recovery failure and manual retry. Distinguish browser connection state from task state and preserve input where supported.
- **Acceptance:** Disconnect and reconnect an isolated fixture to the same job; verify unsent input and history and ensure no duplicate submission or automatic Enter. Clearly disclose when recovery cannot be established.
- **Evidence (2026-11-04):** Isolated Mac and Linux Chrome/tmux fixtures exercised failed authentication, disconnection, retry, an existing job and an unsubmitted shell draft without automatic submission. The Mac fixture retained tmux history across reload; its new connection returned to the default window, and the original window was reached with the toolbar. The candidate explicitly tells users to check the Mac window after reconnecting; automatic restoration of the previous window is not implemented. The Mac token request timeout, bounded retries, paused input and Linux same-session retry were also tested. Neither candidate is deployed; physical devices and actual task health remain unverified.

### WT-005: Improve workspace navigation

- **Status:** Open
- **Scope:** Evaluate named views, a clear active target, keyboard switching, focus, and explanatory feedback about closing a view versus ending a task. Preserve current session semantics.
- **Acceptance:** Navigate views by keyboard with visible focus and identifiable labels at narrow and desktop widths. Closing or switching a disposable view does not end an unrelated tmux job.

### WT-006: Bind upload completion to the intended view

- **Status:** Open
- **Scope:** First reproduce the hypothesis that changing views during an upload may change the insertion target. If confirmed, retain the original target and provide an explicit copy or retry path when it is unavailable.
- **Acceptance:** Tests for view switching, disconnect, and target loss never silently insert into a different view; a saved path remains available and no Enter is sent. A path alone is not evidence of an accepted CLI attachment.

### WT-007: Verify upload resource limits under interruption

- **Status:** Verified
- **Scope:** Verify and correct the upload-work limit across client disconnect, interrupted request bodies, rejected oversized streams, and image-inspection timeout.
- **Acceptance:** Disposable interruption and timeout tests establish whether actual processing stays within the selected limit. Malformed and oversized images fail without uncontrolled work or unintended file changes.
- **Evidence (2026-11-04):** An isolated HTTP regression first reproduced a fifth inspection starting after a client disconnected while four inspections were still active. The candidate now retains the slot until asynchronous work ends. Tests cover disconnect during inspection, abort while receiving, repeated oversized chunked uploads, an actual subprocess timeout using a controlled test inspector, file cleanup, and subsequent capacity recovery. The macOS fixture also checks malformed images and declared and streamed size limits. The change is not deployed to the separately maintained live service.

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
- **Display observation (2026-11-04):** In an isolated Linux Chromium emulation at 1280×800 and device scale factor 1, the terminal canvas appeared undersized in both the unmodified baseline and the connection-recovery candidate. A scale factor 2 emulation displayed normally. The cause and behavior on physical devices remain unverified; this does not establish a candidate regression.

### WT-012: Assess dependency upgrades

- **Status:** In progress
- **Scope:** Compare installed and candidate dependency versions and their configuration and path-handling behavior against vendor documentation before an upgrade.
- **Acceptance:** Record versions and relevant compatibility differences; test route protection and reconnect in isolation and prepare a verified rollback before any authorized live upgrade.
- **Evidence (2026-11-04):** See the [dependency assessment](docs/dependency-assessment.md) for Cloudflare's security recommendation, dated vendor sources, offline ingress comparisons, and an isolated Node LTS build and test. Access enforcement and reconnect with the candidate connector and a verified rollback remain untested; no live upgrade has been made.

## Working order

Complete WT-001's access evidence and use the isolated, reviewable foundation from WT-002. Reproduce WT-003, WT-006, and WT-007 with disposable fixtures before proposing behavioral changes. WT-004 and WT-005 can then be designed and tested against that foundation; prioritize P2 based on observed user needs. Live deployment and disruptive maintenance require their own authorization and rollback plan.
