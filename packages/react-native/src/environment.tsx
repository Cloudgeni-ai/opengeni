import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import type { OpenGeniReactNativeAdapters } from './adapters'
import { sha256HexToArrayBuffer } from './adapters'

interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  dispatch(type: string): void
}

function createEventTarget(): EventTargetLike {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type, listener) => {
      const existing = listeners.get(type) ?? new Set<() => void>()
      existing.add(listener)
      listeners.set(type, existing)
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener)
    },
    dispatch: (type) => {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  }
}

interface InstalledEnvironment {
  cleanup(): void
}

/** Install only the browser-compatible primitives currently read by the official session hooks. */
export function installOpenGeniReactNativeEnvironment(
  adapters: OpenGeniReactNativeAdapters
): InstalledEnvironment {
  const globals = globalThis
  const windowTarget = createEventTarget()
  const documentTarget = createEventTarget()
  const existingWindow = Reflect.get(globals, 'window')
  const existingSessionStorage = Reflect.get(globals, 'sessionStorage')
  const existingDocument = Reflect.get(globals, 'document')
  const existingCrypto = Reflect.get(globals, 'crypto')
  const nativeWindow = createDelegatingObject(isObject(existingWindow) ? existingWindow : globals)
  let lifecycleState = adapters.lifecycle.currentState()

  const sessionStorage = {
    getItem: (key: string) => adapters.persistence.getItem(key),
    setItem: (key: string, value: string) => adapters.persistence.setItem(key, value),
    removeItem: (key: string) => adapters.persistence.removeItem(key),
    clear: () => adapters.persistence.clear(),
    key: () => null,
    get length() {
      return 0
    },
  }

  const nativeCrypto = createDelegatingObject(isObject(existingCrypto) ? existingCrypto : null)
  const subtleValue = isObject(existingCrypto) ? Reflect.get(existingCrypto, 'subtle') : undefined
  const nativeSubtle = createDelegatingObject(isObject(subtleValue) ? subtleValue : null)
  Reflect.set(nativeCrypto, 'randomUUID', () => adapters.crypto.randomUUID())
  Reflect.set(
    nativeSubtle,
    'digest',
    async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name
      if (name.toUpperCase() !== 'SHA-256') {
        throw new TypeError(`Unsupported native digest algorithm: ${name}`)
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      return sha256HexToArrayBuffer(await adapters.crypto.sha256Hex(bytes))
    }
  )
  Reflect.set(nativeCrypto, 'subtle', nativeSubtle)
  Reflect.set(globals, 'crypto', nativeCrypto)

  Reflect.set(nativeWindow, 'sessionStorage', sessionStorage)
  if (typeof Reflect.get(nativeWindow, 'setTimeout') !== 'function') {
    Reflect.set(nativeWindow, 'setTimeout', globalThis.setTimeout.bind(globalThis))
  }
  if (typeof Reflect.get(nativeWindow, 'clearTimeout') !== 'function') {
    Reflect.set(nativeWindow, 'clearTimeout', globalThis.clearTimeout.bind(globalThis))
  }
  if (typeof Reflect.get(nativeWindow, 'addEventListener') !== 'function') {
    Reflect.set(nativeWindow, 'addEventListener', (type: string, listener: () => void) =>
      windowTarget.addEventListener(type, listener)
    )
  }
  if (typeof Reflect.get(nativeWindow, 'removeEventListener') !== 'function') {
    Reflect.set(nativeWindow, 'removeEventListener', (type: string, listener: () => void) =>
      windowTarget.removeEventListener(type, listener)
    )
  }
  Reflect.set(globals, 'window', nativeWindow)
  Reflect.set(globals, 'sessionStorage', sessionStorage)

  const nativeDocument = {
    get visibilityState() {
      return lifecycleState === 'active' ? 'visible' : 'hidden'
    },
    addEventListener: (type: string, listener: () => void) =>
      documentTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      documentTarget.removeEventListener(type, listener),
  }
  Reflect.set(globals, 'document', nativeDocument)

  const unsubscribe = adapters.lifecycle.subscribe((next) => {
    const wasActive = lifecycleState === 'active'
    lifecycleState = next
    documentTarget.dispatch('visibilitychange')
    if (!wasActive && next === 'active') windowTarget.dispatch('pageshow')
  })

  return {
    cleanup: () => {
      unsubscribe()
      restoreGlobal(globals, 'window', nativeWindow, existingWindow)
      restoreGlobal(globals, 'sessionStorage', sessionStorage, existingSessionStorage)
      restoreGlobal(globals, 'document', nativeDocument, existingDocument)
      restoreGlobal(globals, 'crypto', nativeCrypto, existingCrypto)
    },
  }
}

function restoreGlobal(
  target: typeof globalThis,
  key: string,
  installedValue: unknown,
  previousValue: unknown
): void {
  if (Reflect.get(target, key) !== installedValue) return
  if (previousValue === undefined) Reflect.deleteProperty(target, key)
  else Reflect.set(target, key, previousValue)
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function createDelegatingObject(prototype: object | null): object {
  const value = {}
  Object.setPrototypeOf(value, prototype)
  return value
}

export interface NativeEnvironmentContextValue {
  adapters: OpenGeniReactNativeAdapters
  active: boolean
}

const NativeEnvironmentContext = createContext<NativeEnvironmentContextValue | null>(null)

export interface OpenGeniReactNativeProviderProps {
  adapters: OpenGeniReactNativeAdapters
  children: ReactNode
  loadingFallback?: ReactNode
}

export function OpenGeniReactNativeProvider({
  adapters,
  children,
  loadingFallback = null,
}: OpenGeniReactNativeProviderProps) {
  const [hydrated, setHydrated] = useState(false)
  const [active, setActive] = useState(adapters.lifecycle.currentState() === 'active')

  useEffect(() => {
    let mounted = true
    setHydrated(false)
    void adapters.persistence.hydrate().then(() => {
      if (!mounted) return
      setHydrated(true)
    })
    const unsubscribe = adapters.lifecycle.subscribe((state) => setActive(state === 'active'))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [adapters])

  useLayoutEffect(() => {
    const installed = installOpenGeniReactNativeEnvironment(adapters)
    return () => {
      // React removes parent layout effects before passive effects in deleted children.
      // Keep the browser primitives alive until those official hook cleanups have run.
      globalThis.setTimeout(() => installed.cleanup(), 0)
    }
  }, [adapters])

  const value = useMemo(() => ({ adapters, active }), [active, adapters])
  if (!hydrated) return loadingFallback
  return (
    <NativeEnvironmentContext.Provider value={value}>{children}</NativeEnvironmentContext.Provider>
  )
}

export function useOpenGeniReactNativeEnvironment(): NativeEnvironmentContextValue {
  const value = useContext(NativeEnvironmentContext)
  if (!value) {
    throw new Error('OpenGeni native hooks require OpenGeniReactNativeProvider')
  }
  return value
}
