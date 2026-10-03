import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { OpenGeniReactNativeAdapters } from './adapters'
import { installOpenGeniReactNativeEnvironment } from './environment'

function adapters(): OpenGeniReactNativeAdapters {
  return {
    lifecycle: {
      currentState: () => 'active',
      subscribe: () => () => undefined,
    },
    persistence: {
      hydrate: async () => undefined,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      flush: async () => undefined,
      invalidate: async () => undefined,
    },
    crypto: {
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      sha256Hex: async () => '00'.repeat(32),
    },
    files: {
      pickDocuments: async () => [],
      pickImages: async () => [],
      readBytes: async () => new Uint8Array(),
    },
    fetch: globalThis.fetch,
  }
}

describe('installOpenGeniReactNativeEnvironment', () => {
  test('installs isolated browser-compatible globals and restores the previous environment', () => {
    const previousWindow = Reflect.get(globalThis, 'window')
    const previousDocument = Reflect.get(globalThis, 'document')
    const previousStorage = Reflect.get(globalThis, 'sessionStorage')
    const previousCrypto = Reflect.get(globalThis, 'crypto')

    const installed = installOpenGeniReactNativeEnvironment(adapters())

    expect(Reflect.get(globalThis, 'window')).not.toBe(previousWindow)
    expect(Reflect.get(globalThis, 'document')).not.toBe(previousDocument)
    expect(Reflect.get(globalThis, 'sessionStorage')).not.toBe(previousStorage)

    installed.cleanup()

    expect(Reflect.get(globalThis, 'window')).toBe(previousWindow)
    expect(Reflect.get(globalThis, 'document')).toBe(previousDocument)
    expect(Reflect.get(globalThis, 'sessionStorage')).toBe(previousStorage)
    expect(Reflect.get(globalThis, 'crypto')).toBe(previousCrypto)
  })

  test('keeps provider globals independent of hydration-driven child unmounts', () => {
    const source = readFileSync(new URL('./environment.tsx', import.meta.url), 'utf8')
    const layoutEffect = source.indexOf('useLayoutEffect(() => {')
    const install = source.indexOf('installOpenGeniReactNativeEnvironment(adapters)', layoutEffect)
    const layoutEffectEnd = source.indexOf('}, [adapters])', install)
    const hydrationGate = source.indexOf('if (!hydrated) return loadingFallback')

    expect(layoutEffect).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(layoutEffect)
    expect(layoutEffectEnd).toBeGreaterThan(install)
    expect(source.slice(layoutEffect, layoutEffectEnd)).not.toContain('hydrated')
    expect(source.slice(install, layoutEffectEnd)).toContain(
      'globalThis.setTimeout(() => installed.cleanup(), 0)'
    )
    expect(hydrationGate).toBeGreaterThan(layoutEffectEnd)
  })
})
