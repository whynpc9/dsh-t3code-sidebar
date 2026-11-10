/**
 * dsh-t3code-sidebar — Host entry.
 *
 * Registers the `t3Sidebar` task-state service once the storage domain
 * facility is available. The browser half ships through exports["./client"].
 */
import type { Context } from '@deepseek-ai/cordis'
import { T3SidebarService } from './host/service.ts'

export const name = 'dsh-t3code-sidebar'
export const inject = ['storageDomain']

/**
 * `DSH_T3_SIDEBAR_HOST=off` skips the Host half (operator kill switch and the
 * way to exercise the browser-only preview); the browser half then falls back.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_T3_SIDEBAR_HOST === 'off') return
  ctx.plugin(T3SidebarService)
}
