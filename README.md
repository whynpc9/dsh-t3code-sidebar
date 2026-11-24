# dsh-t3code-sidebar

English | [中文](README.zh.md)

A T3 Code-style task sidebar for DeepSeek Harness. It preserves the native Workspaces layout and interactions while organizing sessions by task status, workspace, or one list.

> **v0.1.0 stable**. Linux Web with `@deepseek-ai/dsh` `0.2.2-rc.1` is verified. macOS Desktop is partially verified, with delivery at the original off-peak boundary and a quit stall observed in testing still to investigate. Windows is unverified. See the [support matrix and known limitations](docs/release.md).

## Features

- **Three layouts**: by status (default), by workspace, or one list, with search and archive filters.
- **Task sections**: Pinned, Active, Snoozed, and Settled; empty sections stay hidden. An optional **Working** section (off by default) folds running sessions out of Active; they return to Active when they need you.
- **Off-peak choices**: hide a session with **Until off-peak**, or explicitly choose **Resume at off-peak…** to have the Harness send an editable message into a known-idle session when half-price hours begin. Off-peak actions are on by default.
- **Task organization**: Snooze, manual settling, result acknowledgement, and automatic settling after 7 days of inactivity by default.
- **Message history search** (optional, off by default): search also finds text from your messages and the agent's replies in every stored session, with the match highlighted. The Host reads sessions on the first search and keeps the text in memory only.
- **Flexible policies**: disable automatic settling or set a window of 1–90 days, with workspace overrides and per-session exemptions.
- **Native experience**: session menus, workspace management, English and Chinese, light and dark themes, and the narrow Harness rail.

## Installation

Install stable v0.1.0 in a test profile first:

```sh
dsh plugin --profile <profile> add dsh-t3code-sidebar@0.1.0
dsh --profile <profile>
```

Removing the plugin restores the native sidebar without affecting sessions or chat history:

```sh
dsh plugin --profile <profile> remove dsh-t3code-sidebar
```

See the [release notes](docs/release.md) for upgrades, rollback, local tarball installation, and registry verification.

## Usage

- Use **View options** in the sidebar to change grouping and archive filters. On macOS, press `⌘K` to search and `⌘O` to add a workspace.
- Use a session's **… menu** to snooze, settle, acknowledge a result, or exempt it from automatic settling. Archiving remains a native menu action.
- Open **Plugins → dsh-t3code-sidebar** to manage the Working section, **Off-peak snooze** and **Search message history**, configure automatic settling and workspace policies, preview their effects, and review recent changes. **View options → Sidebar settings…** in the sidebar opens the same page.

Snoozing and settling only change how sessions are organized in the sidebar. They do not stop tasks, archive sessions, or delete content. **Resume at off-peak…** is the explicit exception: it creates a Harness scheduled task that sends your message. The Host persists task state by default; the browser-only fallback has a more limited lifecycle, described in [known limitations](docs/release.md#5-known-limitations).

### Off-peak snooze and resume

**Activation and schedule.** **Plugins → dsh-t3code-sidebar → Sidebar → Off-peak snooze** is on by default and is stored per browser. The setting shows the current pricing phase, peak hours converted to your time zone, and a link to [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing). Turn it off to hide both Off-peak actions; this does not cancel an already scheduled resume.

The bundled peak schedule is **01:00–04:00 and 06:00–10:00 UTC, Monday–Friday**, except Chinese public holidays. Holiday data covers 2026–2027; later years fall back to the weekday rule until the data is refreshed. The Off-peak entries appear only during a peak block. If the next Off-peak window is under four hours, **Until longer off-peak** and the corresponding resume choice target the first later window of at least four hours.

**Until off-peak — display only.** For a session that is not working, open **… → Snooze → Until off-peak**. The row reads **Off-peak at …** and returns to Active at the boundary. It does not send a message, create an Automation task, or pause the agent. The usual Snooze restrictions still apply, including unpinning the session and resolving pending approvals first.

**Resume at off-peak… — display plus a scheduled message.** This is offered only to the Host owner, with the Host backend and Harness scheduler available, for a session known to be fully idle: no running turn, subagent, job, other scheduled work, or pending question or approval. The browser-only fallback does not offer it.

In the dialog, choose the Off-peak boundary and edit the non-empty message; the English default is **Continue.** and the Chinese default is **继续。** Selecting **Schedule** hides the session, changes its row to **Resumes at …**, and creates a one-shot **Off-peak resume** task visible under the Harness's **Automation tasks**. At the boundary, the Harness—not the sidebar—delivers that message so the agent can continue.

**Cancellation and downtime.** Before delivery, **Return now and cancel resume** returns the session to Active and cancels the scheduled message; **Settle** also cancels it. Sending a message yourself, or a new question, approval, or failure that wakes the Snooze, cancels it too. You can instead delete the task under **Automation tasks** to cancel only the Harness message. Cancellation is best effort with bounded retries.

The Host must be running for delivery. If it is down at the boundary, the Harness delivers the overdue message after restart, possibly during a later peak block; the plugin does not move it back to Off-peak. See [known limitations](docs/release.md#5-known-limitations) for late delivery and cancellation caveats.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run verify  # Typecheck, test, build, and check the npm package
pnpm pack
```

- `src/domain/`: pure functions for states, sorting, time, and commands
- `src/contracts/`: shared schemas and Remote contracts
- `src/host/`: persistence, event processing, and scheduling
- `src/client/`: backend adapters, view models, and React UI
- `tests/`: unit, component, integration, and end-to-end tests

## Documentation

- [Documentation index](docs/README.md): design, research, and validation materials
- [Release notes and support matrix](docs/release.md)
- [CHANGELOG](CHANGELOG.md)

[MIT License](LICENSE)
