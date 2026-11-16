# Documentation index

English | [中文](README.zh.md)

Most users only need the [project README](../README.md) and [release notes](release.md). The remaining directories preserve design rationale and validation evidence.

## Current information

- [Project README](../README.md): features, installation, usage, and development entry points.
- [Release notes and support matrix](release.md): verified platforms, upgrades and rollback, release gates, and known limitations.
- [CHANGELOG](../CHANGELOG.md): version history.
- [Design documentation](design/README.md): product behavior, UI, implementation contracts, and time policies (documents in Chinese).
- [Validation records](validation/README.md): test environments, results, screenshots, and raw data (documents in Chinese).

## Reference and history

- [Upstream research](research/README.md): fixed-version source research recording upstream facts at design time, not current implementation status (Chinese).
- [Development plan](archive/development-plan.md): early task breakdown and milestones, kept only as history and no longer maintained (Chinese).

## Short plugin-page details

- [中文](DETAIL.zh.md) / [English](DETAIL.md): selected by `meta.detail` in `locale/*.json` and displayed before the configuration controls on the Plugins detail page.
- These files are intentionally brief rather than a full installation or feature guide. After editing them, run `pnpm run pack:check` to confirm that they are published without the internal `docs/` materials.
