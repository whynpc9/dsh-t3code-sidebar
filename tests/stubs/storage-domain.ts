// Test stand-in for @deepseek-ai/dsh-storage-domain: spec helpers only.
export const defineDomain = <S>(spec: S): S => spec
export const domainTable = <V>(schema: V) => ({ valueSchema: schema })
