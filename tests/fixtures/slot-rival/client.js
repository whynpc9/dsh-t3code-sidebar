window.__ModuleLoader__.load({
  id: 'dsh-t3code-slot-rival-fixture',
  factory: (require) => {
    const { createElement } = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
          name: 'sidebar.workspaces',
          priority: -20,
        }, () => createElement('div', { 'data-testid': 'q03-slot-rival' }, 'Fixture workspace slot')))
      },
    }
  },
});
