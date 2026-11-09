// Host-side Cordis declaration merges for the Harness services and events this
// plugin consumes. Shapes are the narrow views from src/host/harness.ts.
import type { HostSession, HostSessionEvent } from '../host/harness.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    storageDomain: unknown
  }
  interface Events {
    'session/event'(session: HostSession, event: HostSessionEvent): void
  }
}
