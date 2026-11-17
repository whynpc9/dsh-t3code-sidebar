# Release notes, support matrix, and release gates (R01)

English | [中文](release.zh.md)

Updated 2026-11-16 for `0.1.0-preview.0` (v0.1-preview, npm `preview` tag). This document applies the release tiers in sections 7 and 11 of the [development plan](archive/development-plan.md): what has evidence and what remains uncovered. Do not claim any item not marked as passed. See the [CHANGELOG](../CHANGELOG.md) for version history.

## 1. Support matrix

`engines.dsh` declares `>=0.2.2-rc.1 <0.3.0` (intentionally not narrowed further by the maintainer), but only the combinations below have test evidence.

| Runtime | Platform | Plugin version | Status | Evidence |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh` 0.2.2-rc.1 | Linux Web (WSL2, headless Chromium 1243) | 0.1.0-alpha.2 → 0.1.0-preview.0 | **Verified**: installation, main scenarios, Host restart, approvals, shortcuts, workspace policies and result acknowledgement, scale and lifecycle ([Q02/Q03](validation/q02-q03/README.md)), and access revocation ([A10](validation/a10/README.md)) | [Validation record · 2026-11-12](validation/poc/README.md#2026-11-12-linux-web-复验alpha2) |
| `@deepseek-ai/dsh` 0.2.2-rc.1 | macOS Desktop 26.6.2 (arm64, Electron 44.7) | 0.1.0-alpha.0 / alpha.1 builds | **Partially verified** (#2/#3 ⌘Q restart flow, uninstall/reinstall, upgrade/rollback, and rival plugins); the alpha.2 ⌘K/⌘O fix **has not been reverified on Desktop** | [Validation record · macOS Desktop](validation/poc/README.md#2026-11-11-macos-desktop-复验issue-4) |
| `@deepseek-ai/dsh` 0.2.2-rc.3 | macOS Desktop 27.0.1 (arm64) | 0.1.0-preview.0 baseline build | **Partially verified**: basic loading, off-peak snooze, scheduled delivery and cancellation; M6 remains incomplete | [Validation record](validation/desktop-v010-2026-11-17.md) |
| Other versions | Any | — | Unverified | — |
| Windows Desktop / Windows Web | — | — | Unverified | — |

## 2. Release tiers and current position

| Tier | Exit criteria | Status |
| --- | --- | --- |
| R0 internal alpha | Installable in a test profile; task view, native actions, manual Snooze/Settled | Achieved |
| v0.1-preview (Linux Web) | Evidence on Linux Web for F01–F11, A01–A12, T01–T09, and the time portions of T12 | **`0.1.0-preview.0` released**: evidence exists for every item; see sections 4 and 5 for uncovered cases |
| v0.1 (Web + Desktop) | macOS Desktop installation, uninstallation, and GUI acceptance in addition to preview | Not achieved: Desktop reverification (M6) is incomplete |

## 3. Installation, upgrades, and rollback

See [README · Installation](../README.md#installation). Key points:

- Install prebuilt tarballs (`pnpm pack` output) only in newly created test profiles.
- `plugin add` is a no-op for a tarball with the **same version number**. Increment `version` for upgrade tests, or `remove` before `add`.
- To roll back, run `dsh plugin --profile <p> remove dsh-t3code-sidebar`, then `add` the previously verified tarball. Plugin metadata in the `t3_sidebar` storage domain survives uninstallation. When older versions read fields added in alpha.2 (`keepUnacknowledgedResults`, `workspaceOverrides`, `resultAcknowledgedSeq`, and global grace/membership records), zod defaults discard those fields. The rolled-back version follows its old rules without corrupting data, but workspace overrides and result acknowledgements must be configured again after upgrading.
- Operational switch `DSH_T3_SIDEBAR_HOST=off`: skips the Host service, uses the browser-local preview, and explains why on the settings page.

## 4. Release gate review (v0.1-preview, Linux Web)

| Gate | Status | Notes |
| --- | --- | --- |
| F01–F11 features | Evidence available | End-to-end `scenario.mjs` 20/20 and `features.mjs` 14/14; 230 unit/component tests |
| A02 pending approval / A03 wake on new approval | **Passed (Linux Web)** | bubblewrap is unavailable on this machine, so bash does not request sandbox escalation; the test-only `approval-gate` fixture triggers the real approval flow |
| A07 search races / A08 keyboard | Automated | `tests/client/sidebar.spec.tsx` (real DOM) + e2e N09 |
| A10 access revocation / guest | **Passed (Web, isolated Gateway fixture)** | Guests keep the native sidebar; revocation withdraws the task view and denies writes and later stream frames; unknown writes are rejected; owners retain the local preview when the task API is off. See the [validation record](validation/a10/README.md) |
| A12 scale | **Passed the tested load on Linux Web** | 100 workspaces / 5,000 sessions / 50 concurrent turns. First render, local updates, search, layout switching, and bounded one-list rows during long scrolls are within budget. See [Q02 measurements](validation/q02-q03/README.md). |
| Screen reader / locate current session | **U07 partially passed** | Current-session location, narrow windows, and keyboard focus paths were reverified on Desktop. VoiceOver was skipped for this round. See the [U07 record](validation/u07/README.md) |
| T01–T09 | Unit/service tests | Real multi-day automatic settling remains covered only by fake clocks (minimum window: 1 day) |
| Q03 lifecycle and repeated restarts | **Functional pass on Linux Web** | Installation, upgrade, rollback, uninstall, reinstall, slot rivalry, missing Host service, and 20 real Loader restarts verified. Across 100 runs, task DOM and follow streams reached zero after disable; browser heap still grew, primarily from V8 compilation. Real network loss and long-duration scenarios were skipped for this round. See [Q03 measurements](validation/q02-q03/README.md#q03--安装冲突与启停). |
| Licensing | MIT LICENSE included | Dependencies are shared with the host; build output contains no third-party source copies (pack check). The bundled Chinese public holiday dates come from [holiday-cn](https://github.com/NateScarlet/holiday-cn) (MIT, © 2019 NateScarlet) |
| npm package name availability | **Confirmed** | `npm view dsh-t3code-sidebar` returned 404 on 2026-11-16; the name was unclaimed |
| Release process | Configured | Use `pnpm run release:preview` (`pnpm publish --tag preview`) so previews do not take `latest`. pnpm 11 does not read `publishConfig.tag`; plain `pnpm publish` uses `latest`, and `prepublishOnly` cannot intercept it because the tag is unavailable there. `publishConfig.tag` remains a fallback for `npm publish`. `prepublishOnly` runs `pnpm run verify` |
| Off-peak schedule data | Maintenance | Before a release, re-check the [DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing) against `DEEPSEEK_SCHEDULE` in `src/domain/offpeak.ts` and update `verifiedOn`; when a new year's Chinese holiday schedule is published, run `pnpm run holidays:update <year>` |
| Registry installation | **Pending post-publish verification** | After publishing, run `dsh plugin --profile <p> add dsh-t3code-sidebar@preview` in a new test profile and confirm that both Host and Client load; use `npm view dsh-t3code-sidebar dist-tags` to confirm that `preview` points to `0.1.0-preview.0` |

## 5. Known limitations

- Only Linux Web + dsh 0.2.2-rc.1 is officially supported; macOS Desktop is partially verified (M6 incomplete), and Windows is unverified.
- Real multi-day automatic Settled transitions are covered only by fake clocks; VoiceOver announcements have not been accepted.
- Native row-decoration slots, manual drag ordering, and workspace-tree grouping are unavailable (see [Native sidebar design §9](design/native-sidebar-design.md)).
- ⌘K / ⌘O depend on the request store injected by the native `sidebar.workspaces` registration (public `ctx.slots.entries`). If the host changes that injection shape, the shortcuts silently stop working. Linux Web does not bind these commands by default (the host defaults contain no `web:linux` binding).
- Automatic-settling protections rely on facts visible to the Host. Timed questions still awaiting answers outside a turn are read through exact projections; read failures skip the session and report “state unknown.”
- Browser-local preview mode has no automatic Settled, and Snooze returns only while the browser is open.
- Transition auditing is best-effort: an audit write failure after the main record commits can leave gaps. Use record `receipts` and revisions for diagnostics.
- Automatic Archived and PR/quota rules are not part of v0.1 (planned for v0.2/v0.3).
- **Resume at off-peak** relies on the Harness scheduler, which delivers only while the Host runs. A message whose time passed while the Host was down is delivered right after the Host starts again, possibly in a later peak block; the plugin does not re-arm or move it. Deleting the scheduled task (on an early return) is best effort, and the Harness adds a short non-waking “schedule changed” notice to the session's context on create and delete.
