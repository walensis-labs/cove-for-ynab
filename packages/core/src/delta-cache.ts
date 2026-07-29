interface Entry { serverKnowledge: number; items: Map<string, { id: string; deleted?: boolean }> }

export class DeltaCache {
  #store = new Map<string, Entry>()

  #key(planId: string, resource: string): string {
    return `${planId}:${resource}`
  }

  knowledge(planId: string, resource: string): number | undefined {
    return this.#store.get(this.#key(planId, resource))?.serverKnowledge
  }

  merge<T extends { id: string; deleted?: boolean }>(planId: string, resource: string, serverKnowledge: number, incoming: T[]): T[] {
    const key = this.#key(planId, resource)
    const entry = this.#store.get(key) ?? { serverKnowledge, items: new Map() }
    entry.serverKnowledge = serverKnowledge
    for (const item of incoming) {
      if (item.deleted) entry.items.delete(item.id)
      else entry.items.set(item.id, item)
    }
    this.#store.set(key, entry)
    return [...entry.items.values()] as T[]
  }

  invalidate(planId: string): void {
    const prefix = `${planId}:`
    for (const k of [...this.#store.keys()]) if (k.startsWith(prefix)) this.#store.delete(k)
  }
}
