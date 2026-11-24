# dsh-t3code-sidebar

English | [中文](README.zh.md)

A T3 Code-style task sidebar for DeepSeek Harness. It preserves the native Workspaces layout and interactions while organizing sessions by task status, workspace, or one list.

> This is **v0.1-preview**. It has been verified on Linux Web with `@deepseek-ai/dsh` `0.2.2-rc.1`; macOS Desktop is only partially verified, and Windows is unverified. See the [support matrix and known limitations](docs/release.md).

## Features

- **Three layouts**: by status (default), by workspace, or one list, with search and archive filters.
- **Task sections**: Pinned, Active, Snoozed, and Settled; empty sections stay hidden. An optional **Working** section (off by default) folds running sessions out of Active; they return to Active when they need you.
- **Task organization**: Snooze (including **Until off-peak** during DeepSeek peak pricing hours, and **Resume at off-peak…**, which has the Harness send a message into an idle session when off-peak begins), manual settling, result acknowledgement, and automatic settling after 7 days of inactivity by default.
- **Message history search** (optional, off by default): search also finds text from your messages and the agent's replies in every stored session, with the match highlighted. The Host reads sessions on the first search and keeps the text in memory only.
- **Flexible policies**: disable automatic settling or set a window of 1–90 days, with workspace overrides and per-session exemptions.
- **Native experience**: session menus, workspace management, English and Chinese, light and dark themes, and the narrow Harness rail.

## Installation

Try the plugin in a test profile first:

```sh
dsh plugin --profile <profile> add dsh-t3code-sidebar@preview
dsh --profile <profile>
```

Removing the plugin restores the native sidebar without affecting sessions or chat history:

```sh
dsh plugin --profile <profile> remove dsh-t3code-sidebar
```

See the [release notes](docs/release.md) for upgrades, rollback, and local tarball installation.

## Usage

- Use **View options** in the sidebar to change grouping and archive filters. On macOS, press `⌘K` to search and `⌘O` to add a workspace.
- Use a session's **… menu** to snooze, settle, acknowledge a result, or exempt it from automatic settling. Archiving remains a native menu action.
- Open **Plugins → dsh-t3code-sidebar** to turn on the Working section, off-peak snooze or message history search, configure automatic settling and workspace policies, preview their effects, and review recent changes. **View options → Sidebar settings…** in the sidebar opens the same page.

Snoozing and settling only change how sessions are organized in the sidebar. They do not stop tasks, archive sessions, or delete content. The one exception you choose explicitly is **Resume at off-peak…**, which creates a Harness scheduled task that sends your message; returning to the session early deletes it. The Host persists task state by default; see [known limitations](docs/release.md#5-known-limitations) for behavior when it is unavailable.

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
