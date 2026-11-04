# Resize, lifecycle and platform evidence

Reviewed 2026-11-04. These are observations of the named disposable fixtures, not guarantees about the separately maintained live services. A tmux pane contains a status line, so its usable height can be one row less than the attached terminal client. Grid equality is not proof that text is visible above a physical soft keyboard.

| Environment | Trigger and measured result | Fixture job outcome | Reconnect result and limit |
| --- | --- | --- | --- |
| Mac candidate; Chrome 156 emulation, macOS, ttyd 1.7.7, tmux 3.6a | Resize from 1280×800 to 800×600, device scale 2. At the observations, xterm and the tmux client both reported 160×48 then 103×35; the tmux pane was 160×47 then 103×34. | Foreground shell remained present; no background job was used in this resize check. | The browser remained connected; no reconnect was attempted in this check. Physical display and trackpad were not tested. |
| Linux candidate; Chrome 156 emulation, disposable ARM64 Alpine fixture, ttyd 1.7.7, tmux 3.7c | Same resize and scale. At the observations, xterm and the tmux client both reported 160×49 then 103×36; the tmux pane was 160×48 then 103×35. | Foreground shell remained present; no background job was used in this resize check. | The browser remained connected; no reconnect was attempted in this check. This is not the separately maintained Ubuntu host. |
| Same isolated Mac and Linux fixtures | Reload the browser while a disposable `sleep 120` process runs in a single-window pane. | The pane's shell PID and foreground command were unchanged immediately after reload on both fixtures. | Both browsers reconnected to the tested pane. At 800×600 the reported client and xterm grids were 99×35 on Mac and 99×36 on Linux after reload; the column count differed from the earlier resize observation. Other windows and long-duration survival were not tested here. |
| Linux ARM64 Alpine integration fixture; Node 22.23.4, ttyd 1.7.7, tmux 3.7c | Stop and restart the disposable UI process while tmux and a `sleep 60` fixture job remain running. | The same pane still reported `sleep` after UI restart. | The session-list API again contained the session. This automated check does not assert a browser reconnect or a host restart. See `linux/test/integration.test.js`. |
| Mac and Linux candidate browser fixtures | Simulated WebSocket disconnection and explicit retry, documented under WT-004. | The isolated fixture job and synthetic unsubmitted input were retained in the recorded checks. | Reconnection was to the same fixture job; the Mac connection could return to its default window, requiring the user to check and navigate back. No live session or physical device is covered. |
| Mac and Linux experimental WT-008 branch; Chrome emulation | At a simulated 390×844 viewport with the proposed mobile bar open, xterm and tmux client grids agreed; a smaller 390×450 emulated viewport also agreed. | Synthetic shell input remained unsubmitted in the fixture. | The browser remained connected. This branch was not deployed or merged when measured; a viewport resize is not a real soft keyboard. |

## Unknown or unavailable cases

| Case | Status |
| --- | --- |
| Physical phone, tablet, touch keyboard, trackpad and assistive input | Unknown. Emulation and synthetic wheel events do not establish real device behavior. |
| Host sleep and wake, OS-user logout, reboot, power loss and tmux-server termination | Unknown for each platform. A UI-process restart is a different event. Do not interrupt a live job to infer these results. |
| Browser or OS restart, expired or revoked Access session, and an already-open WebSocket | Unknown for the candidate and actual authorization boundary; see WT-001. |
| Windows, WSL and Xubuntu | Unknown. No equivalent physical or virtual environment was available for the listed checks. |
| Other browser versions, scale factors, fonts and long-running connections | Unknown. An earlier Linux 1280×800 scale-1 emulation appeared undersized in both the baseline and candidate; the cause and physical-device behavior were not established. |
| Current live deployments | Unknown unless separately rechecked. The repository candidates are not automatically deployed. |

When adding a result, record the date, device or fixture, browser and relevant component versions, exact trigger, observed grid, process or job result, reconnect behavior, and what remains unknown. Never include commands or output from a user's real session, credentials, private paths or filenames.
