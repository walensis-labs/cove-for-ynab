import { describe, it, expect } from 'vitest'
import { DeltaCache } from '../src/delta-cache.js'

describe('DeltaCache', () => {
  it('stores knowledge and merges deltas', () => {
    const c = new DeltaCache()
    expect(c.knowledge('p1', 'transactions')).toBeUndefined()
    const first = c.merge('p1', 'transactions', 100, [{ id: 'a', v: 1 } as any, { id: 'b', v: 1 } as any])
    expect(first.map((x: any) => x.id)).toEqual(['a', 'b'])
    expect(c.knowledge('p1', 'transactions')).toBe(100)
    const second = c.merge('p1', 'transactions', 120, [{ id: 'b', v: 2 } as any, { id: 'c', v: 1 } as any])
    expect(second.map((x: any) => `${x.id}${x.v}`)).toEqual(['a1', 'b2', 'c1'])
  })
  it('drops deleted items', () => {
    const c = new DeltaCache()
    c.merge('p1', 'payees', 1, [{ id: 'a' }, { id: 'b' }])
    const live = c.merge('p1', 'payees', 2, [{ id: 'a', deleted: true }])
    expect(live.map((x) => x.id)).toEqual(['b'])
  })
  it('invalidates per plan', () => {
    const c = new DeltaCache()
    c.merge('p1', 'payees', 1, [{ id: 'a' }])
    c.merge('p2', 'payees', 1, [{ id: 'z' }])
    c.invalidate('p1')
    expect(c.knowledge('p1', 'payees')).toBeUndefined()
    expect(c.knowledge('p2', 'payees')).toBe(1)
  })
})
