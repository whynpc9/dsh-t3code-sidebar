# Design documentation

English | [中文](README.zh.md)

These Chinese-language documents record design decisions and acceptance criteria. **The [release notes](../release.md) define current support, while `src/contracts/` defines the actual data contracts.**

- [Product specification](product-spec.md): task semantics, five states, search, actions, and acceptance scenarios; the native sidebar design below supersedes its UI layout sections.
- [Native sidebar design](native-sidebar-design.md): three layouts, session rows, search, settings entry points, and known UI differences.
- [Implementation specification](implementation-spec.md): Host/Client architecture, storage, synchronization, permissions, and lifecycle; the v1 contracts in §4.0 and §5.0 supersede earlier sketches.
- [Time policy specification](time-policy-spec.md): Snooze, automatic settling, grace periods, protections, and audit rules; §0 records the implemented v0.1 scope, while PR, quota, and automatic archiving sections describe later plans.

See the [development plan](../archive/development-plan.md) for early task dependencies and execution history, and the [research index](../research/README.md) for upstream sources.
