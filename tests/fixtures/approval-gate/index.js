// Test-only Host plugin. Without a sandboxing executor (no bubblewrap) the
// bash tool never escalates, so the "ask" approval policy never prompts. This
// gate asks for approval on the mock model's bash calls that carry the
// `approval-fixture` marker, exercising the real approval UI and session state.
// Every other tool call passes through untouched.
export const name = 'dsh-t3code-approval-gate-fixture'
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'bash' && JSON.stringify(exec.arguments ?? null).includes('approval-fixture')) {
      return { kind: 'ask', reason: 'sidebar e2e fixture', displayReason: { en: 'Sidebar e2e fixture asks for approval' } }
    }
    return await next()
  })
}
