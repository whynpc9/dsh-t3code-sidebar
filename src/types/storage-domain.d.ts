// Minimal declaration of the @deepseek-ai/dsh-storage-domain surface this
// plugin uses (0.2.2-rc.1). The running installation supplies the module.
declare module '@deepseek-ai/dsh-storage-domain' {
  import type { ZodType } from 'zod'
  export interface DomainTableSpec<V = unknown> { readonly valueSchema: ZodType<V> }
  export interface DomainSpec {
    readonly name: string
    readonly version: number
    readonly global?: { readonly schema: ZodType<unknown>; readonly initial: unknown }
    readonly tables: Record<string, DomainTableSpec>
  }
  export function defineDomain<S extends DomainSpec>(spec: S): S
  export function domainTable<V>(schema: ZodType<V>): DomainTableSpec<V>
}
