# Changelog

All versions are internal alphas (R0); nothing has been published to npm. The verified runtime is `@deepseek-ai/dsh` `0.2.2-rc.1`; see [docs/release.md](docs/release.md) for the support matrix and release gates.

## 0.1.0-alpha.2 — 2026-11-12

### Added

- **Workspace policy overrides (P01).** Each workspace follows the Host default (inherit), has its own window (custom, 1–90 days), or turns automatic settling off. Grace windows are scoped to the sessions a change governs. A stricter Host default restarts only its followers, and a stricter workspace rule restarts only that workspace's members. A session whose workspace membership changes, and with it its rule, gets its own grace window. In Harness 0.2.2-rc.1 a session belongs to at most one workspace, so no `policyWorkspaceId` choice exists.
- **Result acknowledgement (P04).** New **Keep every new result until it is acknowledged** protection. **Keep failed sessions…** now also covers blocked, max-tokens, interrupted and unknown endings. A held session offers **Acknowledge result** in the session menu, and its hover card shows that it is kept. The acknowledgement is shared across windows, never moves backwards, and is separate from the per-browser read marker. Releasing a keep protection restarts grace.
- **Policy preview.** New `previewPolicy` Remote method. The settings page previews the unsaved draft: sessions due within a minute, the next deadline, skip reasons, and held results, with **Acknowledge all**.
- **Slot diagnostics (S01).** When another plugin renders `sidebar.workspaces`, the settings page names it and explains why this sidebar is not shown.
- Test fixtures: `tests/fixtures/approval-gate` (test-only Host plugin that routes marked bash calls through the real approval flow on hosts without a sandboxing executor), mock-model triggers `#askbash` / `#delaybash`, `tests/e2e/features.mjs`, and the Q02 tools `tests/e2e/scale-seed.mjs` and `tests/e2e/scale.mjs`.

### Fixed

- **⌘K / ⌘O (session search / add workspace) did nothing while this sidebar was active.** The native commands only raise requests for the browser that owns the slot. The sidebar now consumes the same request store from the native registration (through the public `ctx.slots.entries`) and opens search or the add-workspace dialog.
- The settings page no longer discards an edit made before its first effect ran.
- **Settle was never offered on sessions without a plugin record** (every session on a fresh install until it got a record). With a ready Host that reports activity, a session without a view counts as having no background work. The Host now publishes sessions whose activity it could not read, so those stay unknown.
- With a keep protection on, a session whose latest result predates this Host process (written before install or while the Host half was off) could settle without that result being judged. Overdue candidates now have their stored log replayed into the summary first, in the background. Until then, or while the log cannot be read, they are skipped (`result-unknown`). The acknowledgement preview lists them once rebuilt.
- With workspace overrides set, a failed workspace-registry read made every session fall back to the Host default. Such sessions are now skipped (`scope-unknown`).
- **Acknowledge all** now works through every page of held results (the preview lists 200 at a time). It reports success only when none remain.
- **The one list rendered every session.** At 5000 sessions, switching into the one list cost p95 895 ms on Linux Web. It now renders a 200-row window that grows on scroll and always includes the current session (view switch p95 34 ms).

### Changed

- `TimePolicy` gains `keepUnacknowledgedResults` and `workspaceOverrides`, and `TaskRecord` gains `resultAcknowledgedSeq`. Both default when read from older storage, so no migration is needed. Command actions gain `acknowledge-result`. Protocol stays at version 1, because both halves ship in one package.
- Test count: 137 → 217 (DOM component tests for search races, keyboard navigation and the one-list window added).

## 0.1.0-alpha.1 — 2026-11-12 (#6)

- Sidebar composed like the native Workspaces browser: header, search, view options, add workspace, 32px rows, hover cards and actions. Grouping by status (default), by workspace, or in one list. The archived filter matches native.
- Settings moved to this plugin's page under Plugins.

## 0.1.0-alpha.0 fixes — 2026-11-10 / 11 (#3, #5)

- #2: Snoozed/Settled sessions are verified by read-only replay after a restart instead of being woken by a changed persistence token.
- #4: Client reconnects are isolated by generation, setup and failure paths are closed, and lost replies are recovered by resending with the original command id (policy writes by CAS resend).
- pnpm is the single package manager, the frozen lockfile is fixed, and CI runs verify.

## 0.1.0-alpha.0 — 2026-11-09 (#1)

- M0 gates passed on Linux Web. R0 implementation: five task sections, Snooze / Settle, Host storage domain with CAS and receipts, follow stream, policy scheduler with automatic settling (default 7 days), and a browser-only fallback.
