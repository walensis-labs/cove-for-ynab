import { describe, expect, it } from 'vitest'
import * as core from '../src/index.js'
import * as client from '@walensis/ynab-client'

describe('client re-exports preserved', () => {
  it('every ynab-client export is reachable from cove-core', () => {
    for (const k of Object.keys(client)) expect(core, k).toHaveProperty(k)
  })
})
