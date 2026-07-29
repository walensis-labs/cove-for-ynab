import { describe, it, expect } from 'vitest'
import { CORE_VERSION } from '../src/index.js'
describe('scaffold', () => { it('exports core version', () => expect(CORE_VERSION).toBe('0.0.0')) })
