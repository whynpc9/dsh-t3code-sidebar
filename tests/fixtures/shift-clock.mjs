// Test-only Node preload: shift this process's wall clock by a constant, so a
// Harness Host can be tested at a chosen instant (e.g. just before a DeepSeek
// peak block ends) without test hooks in production code. Timers keep real
// durations; only `Date` reads move. Child processes and workers inherit it
// through NODE_OPTIONS.
//   DSH_T3_CLOCK_OFFSET_MS=<ms> NODE_OPTIONS="--import <abs path>/shift-clock.mjs" dsh …
// Compute the offset once (target instant − real now) and reuse it across a
// Host restart, so the shifted clock keeps running instead of jumping back.
const offset = Number(process.env.DSH_T3_CLOCK_OFFSET_MS ?? 0)

if (Number.isFinite(offset) && offset !== 0) {
  const RealDate = Date
  const now = () => RealDate.now() + offset
  function ShiftedDate(...args) {
    if (new.target === undefined) return new RealDate(now()).toString()
    return args.length === 0 ? new RealDate(now()) : new RealDate(...args)
  }
  ShiftedDate.prototype = RealDate.prototype
  Object.defineProperty(RealDate.prototype, 'constructor', { value: ShiftedDate, writable: true, configurable: true })
  ShiftedDate.now = now
  ShiftedDate.parse = RealDate.parse
  ShiftedDate.UTC = RealDate.UTC
  globalThis.Date = ShiftedDate
}
