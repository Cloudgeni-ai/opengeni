import type { FetchLike } from '@opengeni/sdk'

export type NativeLifecycleState = 'active' | 'background' | 'inactive'

export interface NativeLifecycleAdapter {
  currentState(): NativeLifecycleState
  subscribe(listener: (state: NativeLifecycleState) => void): () => void
}

export interface NativePersistenceAdapter {
  hydrate(): Promise<void>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  clear(): void
  flush(): Promise<void>
  invalidate(): Promise<void>
}

export interface AsyncKeyValueStorage {
  getAllKeys(): Promise<readonly string[]>
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface NativeCryptoAdapter {
  randomUUID(): string
  sha256Hex(bytes: Uint8Array): Promise<string>
}

export interface NativePickedFile {
  id: string
  uri: string
  name: string
  contentType: string
  sizeBytes: number | null
  kind: 'document' | 'image'
  previewUri?: string
}

export interface NativeFileAdapter {
  pickDocuments(): Promise<NativePickedFile[]>
  pickImages(): Promise<NativePickedFile[]>
  readBytes(file: NativePickedFile): Promise<Uint8Array>
}

export interface OpenGeniReactNativeAdapters {
  lifecycle: NativeLifecycleAdapter
  persistence: NativePersistenceAdapter
  crypto: NativeCryptoAdapter
  files: NativeFileAdapter
  fetch: FetchLike
}

/**
 * Build the synchronous storage facade required by the official composer from
 * an asynchronous native key/value store. Rendering waits for `hydrate`, so
 * reads never race the initial native load.
 */
export function createHydratedPersistenceAdapter(
  storage: AsyncKeyValueStorage,
  namespace: string
): NativePersistenceAdapter {
  const prefix = `${namespace.replace(/:+$/, '')}:`
  const memory = new Map<string, string>()
  let hydrated = false
  let hydration: Promise<void> | null = null
  let active = true
  let mutations = Promise.resolve()
  let invalidation: Promise<void> | null = null

  const enqueueMutation = (operation: () => Promise<void>) => {
    mutations = mutations.then(operation, operation).catch(() => undefined)
  }

  const removePersistedNamespace = async () => {
    const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(prefix))
    await Promise.all(keys.map((key) => storage.removeItem(key)))
  }

  return {
    hydrate: async () => {
      if (!active) return
      hydration ??= (async () => {
        const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(prefix))
        const entries = keys.length > 0 ? await storage.multiGet(keys) : []
        if (!active) return
        memory.clear()
        for (const [key, value] of entries) {
          if (value !== null) memory.set(key.slice(prefix.length), value)
        }
        hydrated = true
      })()
      await hydration
    },
    getItem: (key) => {
      if (!active || !hydrated) return null
      return memory.get(key) ?? null
    },
    setItem: (key, value) => {
      if (!active) return
      memory.set(key, value)
      enqueueMutation(async () => {
        if (!active) return
        await storage.setItem(`${prefix}${key}`, value)
      })
    },
    removeItem: (key) => {
      if (!active) return
      memory.delete(key)
      enqueueMutation(async () => {
        if (!active) return
        await storage.removeItem(`${prefix}${key}`)
      })
    },
    clear: () => {
      if (!active) return
      memory.clear()
      enqueueMutation(async () => {
        if (!active) return
        await removePersistedNamespace()
      })
    },
    flush: async () => await mutations,
    invalidate: () => {
      if (invalidation) return invalidation
      active = false
      hydrated = false
      memory.clear()
      invalidation = (async () => {
        await hydration?.catch(() => undefined)
        await mutations
        await removePersistedNamespace()
      })()
      return invalidation
    },
  }
}

export function sha256HexToArrayBuffer(hex: string): ArrayBuffer {
  if (!/^[a-f\d]{64}$/i.test(hex)) {
    throw new TypeError('SHA-256 adapter returned an invalid digest')
  }
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes.buffer
}
