interface Entry { serverKnowledge: number; items: Map<string, { id: string; deleted?: boolean }> }

export class DeltaCache {
  #store = new Map<string, Map<string, Entry>>()

  knowledge(planId: string, resource: string): number | undefined {
    return this.#store.get(planId)?.get(resource)?.serverKnowledge
  }

  merge<T extends { id: string; deleted?: boolean }>(planId: string, resource: string, serverKnowledge: number, incoming: T[]): T[] {
    let planMap = this.#store.get(planId)
    if (!planMap) {
      planMap = new Map()
      this.#store.set(planId, planMap)
    }
    const entry = planMap.get(resource) ?? { serverKnowledge, items: new Map() }
    entry.serverKnowledge = serverKnowledge
    for (const item of incoming) {
      if (item.deleted) entry.items.delete(item.id)
      else entry.items.set(item.id, item)
    }
    planMap.set(resource, entry)
    return [...entry.items.values()] as T[]
  }

  invalidate(planId: string): void {
    this.#store.delete(planId)
  }
}
