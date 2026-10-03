import { describe, expect, test } from 'bun:test'
import { createHydratedPersistenceAdapter, sha256HexToArrayBuffer } from './adapters'

describe('createHydratedPersistenceAdapter', () => {
  test('hydrates only its namespace and mirrors writes synchronously', async () => {
    const values = new Map([
      ['opengeni-native:one', '1'],
      ['other:two', '2'],
    ])
    const storage = {
      getAllKeys: async () => [...values.keys()],
      multiGet: async (keys: readonly string[]) =>
        keys.map((key) => [key, values.get(key) ?? null] as const),
      setItem: async (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: async (key: string) => {
        values.delete(key)
      },
    }
    const adapter = createHydratedPersistenceAdapter(storage, 'opengeni-native')

    expect(adapter.getItem('one')).toBeNull()
    await adapter.hydrate()
    expect(adapter.getItem('one')).toBe('1')
    expect(adapter.getItem('two')).toBeNull()

    adapter.setItem('three', '3')
    expect(adapter.getItem('three')).toBe('3')
    await adapter.flush()
    expect(values.get('opengeni-native:three')).toBe('3')

    adapter.removeItem('one')
    expect(adapter.getItem('one')).toBeNull()
    await adapter.flush()
    expect(values.has('opengeni-native:one')).toBe(false)

    adapter.clear()
    expect(adapter.getItem('three')).toBeNull()
    await adapter.flush()
    expect(values.has('opengeni-native:three')).toBe(false)
    expect(values.get('other:two')).toBe('2')
  })

  test('invalidates before draining writes so logout cleanup cannot be recreated', async () => {
    const values = new Map<string, string>()
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const storage = {
      getAllKeys: async () => [...values.keys()],
      multiGet: async (keys: readonly string[]) =>
        keys.map((key) => [key, values.get(key) ?? null] as const),
      setItem: async (key: string, value: string) => {
        markWriteStarted()
        await writeReleased
        values.set(key, value)
      },
      removeItem: async (key: string) => {
        values.delete(key)
      },
    }
    const adapter = createHydratedPersistenceAdapter(storage, 'opengeni-native:user-a')
    await adapter.hydrate()

    adapter.setItem('pending', 'secret')
    await writeStarted
    const invalidated = adapter.invalidate()
    adapter.setItem('late', 'secret')
    releaseWrite()
    await invalidated

    expect(adapter.getItem('pending')).toBeNull()
    expect(values.has('opengeni-native:user-a:pending')).toBe(false)
    expect(values.has('opengeni-native:user-a:late')).toBe(false)
  })
})

describe('sha256HexToArrayBuffer', () => {
  test('converts a validated SHA-256 hex digest to bytes', () => {
    const buffer = sha256HexToArrayBuffer('00'.repeat(31) + 'ff')
    expect([...new Uint8Array(buffer)]).toEqual([...new Uint8Array(31), 255])
  })

  test('rejects malformed digests', () => {
    expect(() => sha256HexToArrayBuffer('abc')).toThrow('invalid digest')
  })
})
