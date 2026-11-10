/** Minimal observable store compatible with React's useSyncExternalStore. */
export interface Readable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface Store<T> extends Readable<T> {
  set(value: T): void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}
