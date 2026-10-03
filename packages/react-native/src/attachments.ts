import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileAsset, ResourceRef } from '@opengeni/sdk'
import type { FileAttachmentClientLike } from '@opengeni/react/session'
import type { NativeCryptoAdapter, NativeFileAdapter, NativePickedFile } from './adapters'

export type NativeAttachmentStatus = 'preparing' | 'uploading' | 'ready' | 'failed'

export const NATIVE_ATTACHMENT_PREPARATION_TIMEOUT_MS = 30_000

export interface NativeAttachment {
  id: string
  name: string
  contentType: string
  sizeBytes: number | null
  kind: NativePickedFile['kind']
  previewUri?: string
  status: NativeAttachmentStatus
  file?: FileAsset
  error?: string
}

export interface NativeFileAttachmentsResult {
  attachments: NativeAttachment[]
  readyResources: ResourceRef[]
  uploading: boolean
  hasUnresolved: boolean
  error: Error | null
  pickDocuments(): Promise<void>
  pickImages(): Promise<void>
  addFiles(files: NativePickedFile[]): Promise<void>
  retry(id: string): Promise<void>
  remove(id: string): void
  clear(): void
  clearError(): void
}

export interface NativeAttachmentScope {
  client: FileAttachmentClientLike
  workspaceId: string
  sessionId: string
}

export function sameNativeAttachmentScope(
  left: NativeAttachmentScope,
  right: NativeAttachmentScope
): boolean {
  return (
    left.client === right.client &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  )
}

export function projectNativeAttachmentScopeState(
  scopeMatches: boolean,
  attachments: NativeAttachment[],
  error: Error | null
): { attachments: NativeAttachment[]; error: Error | null } {
  return scopeMatches ? { attachments, error } : { attachments: [], error: null }
}

export async function runNativeAttachmentPicker(input: {
  generation: number
  currentGeneration(): number
  pick(): Promise<NativePickedFile[]>
  addFiles(files: NativePickedFile[], generation: number): Promise<void>
  onError(error: Error): void
}): Promise<'added' | 'failed' | 'stale'> {
  try {
    const files = await input.pick()
    if (input.currentGeneration() !== input.generation) return 'stale'
    await input.addFiles(files, input.generation)
    return input.currentGeneration() === input.generation ? 'added' : 'stale'
  } catch (cause) {
    if (input.currentGeneration() !== input.generation) return 'stale'
    input.onError(cause instanceof Error ? cause : new Error(String(cause)))
    return 'failed'
  }
}

export async function addNativeFilesForGeneration(input: {
  files: NativePickedFile[]
  generation: number
  currentGeneration(): number
  hasSource(id: string): boolean
  rememberSource(file: NativePickedFile): void
  appendAttachments(files: NativePickedFile[]): void
  upload(file: NativePickedFile, generation: number): Promise<void>
}): Promise<void> {
  if (input.currentGeneration() !== input.generation) return
  const unique = input.files.filter((file) => !input.hasSource(file.id))
  if (unique.length === 0) return
  for (const file of unique) input.rememberSource(file)
  input.appendAttachments(unique)
  await unique.reduce(async (previous, file) => {
    await previous
    if (input.currentGeneration() !== input.generation) return
    await input.upload(file, input.generation)
  }, Promise.resolve())
}

export async function prepareNativeAttachmentUpload(input: {
  source: NativePickedFile
  files: NativeFileAdapter
  crypto: NativeCryptoAdapter
  timeoutMs?: number
}): Promise<{ bytes: Uint8Array; data: ArrayBuffer; sha256: string }> {
  const timeoutMs = input.timeoutMs ?? NATIVE_ATTACHMENT_PREPARATION_TIMEOUT_MS
  const bytes = await withTimeout(
    input.files.readBytes(input.source),
    timeoutMs,
    'File preparation timed out. Retry the upload.'
  )
  const sha256 = await withTimeout(
    input.crypto.sha256Hex(bytes),
    timeoutMs,
    'File verification timed out. Retry the upload.'
  )
  // The OpenGeni SDK accepts either Uint8Array or ArrayBuffer, but its
  // Uint8Array snapshot uses `new Blob([view])`. React Native's Blob rejects
  // ArrayBufferView inputs, so pass an exact ArrayBuffer and avoid that branch.
  const uploadBytes = Uint8Array.from(bytes)
  const data = uploadBytes.buffer
  return { bytes, data, sha256 }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Native attachment timeout must be a positive number')
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([operation, timedOut])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export function useNativeFileAttachments(input: {
  client: FileAttachmentClientLike
  workspaceId: string
  sessionId: string
  files: NativeFileAdapter
  crypto: NativeCryptoAdapter
}): NativeFileAttachmentsResult {
  const [attachments, setAttachments] = useState<NativeAttachment[]>([])
  const [error, setError] = useState<Error | null>(null)
  const sources = useRef(new Map<string, NativePickedFile>())
  const attempts = useRef(new Map<string, number>())
  const scopeGeneration = useRef(0)
  const currentScope = {
    client: input.client,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  } satisfies NativeAttachmentScope
  const previousScope = useRef(currentScope)
  const scopeMatches = sameNativeAttachmentScope(previousScope.current, currentScope)

  useLayoutEffect(() => {
    const nextScope = {
      client: input.client,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    }
    if (sameNativeAttachmentScope(previousScope.current, nextScope)) return
    previousScope.current = nextScope
    scopeGeneration.current += 1
    sources.current.clear()
    attempts.current.clear()
    setAttachments([])
    setError(null)
  }, [input.client, input.sessionId, input.workspaceId])

  useEffect(
    () => () => {
      scopeGeneration.current += 1
      sources.current.clear()
      attempts.current.clear()
    },
    []
  )

  const upload = useCallback(
    async (source: NativePickedFile, generation = scopeGeneration.current) => {
      if (scopeGeneration.current !== generation) return
      const attempt = (attempts.current.get(source.id) ?? 0) + 1
      attempts.current.set(source.id, attempt)
      setAttachments((current) =>
        current.map((entry) =>
          entry.id === source.id ? { ...entry, status: 'preparing', error: undefined } : entry
        )
      )
      try {
        const { data, sha256 } = await prepareNativeAttachmentUpload({
          source,
          files: input.files,
          crypto: input.crypto,
        })
        if (
          scopeGeneration.current !== generation ||
          attempts.current.get(source.id) !== attempt ||
          !sources.current.has(source.id)
        ) {
          return
        }
        setAttachments((current) =>
          current.map((entry) =>
            entry.id === source.id ? { ...entry, status: 'uploading' } : entry
          )
        )
        const file = await input.client.uploadFile(input.workspaceId, {
          filename: source.name,
          contentType: source.contentType,
          data,
          sha256,
        })
        if (
          scopeGeneration.current !== generation ||
          attempts.current.get(source.id) !== attempt ||
          !sources.current.has(source.id)
        ) {
          return
        }
        sources.current.delete(source.id)
        attempts.current.delete(source.id)
        setAttachments((current) =>
          current.map((entry) =>
            entry.id === source.id ? { ...entry, status: 'ready', file, error: undefined } : entry
          )
        )
      } catch (cause) {
        if (
          scopeGeneration.current !== generation ||
          attempts.current.get(source.id) !== attempt ||
          !sources.current.has(source.id)
        ) {
          return
        }
        setAttachments((current) =>
          current.map((entry) =>
            entry.id === source.id
              ? {
                  ...entry,
                  status: 'failed',
                  error: cause instanceof Error ? cause.message : String(cause),
                }
              : entry
          )
        )
      }
    },
    [input.client, input.crypto, input.files, input.workspaceId]
  )

  const addFilesForGeneration = useCallback(
    async (files: NativePickedFile[], generation: number) => {
      await addNativeFilesForGeneration({
        files,
        generation,
        currentGeneration: () => scopeGeneration.current,
        hasSource: (id) => sources.current.has(id),
        rememberSource: (file) => sources.current.set(file.id, file),
        appendAttachments: (unique) =>
          setAttachments((current) => [
            ...current,
            ...unique.map(
              (file): NativeAttachment => ({
                id: file.id,
                name: file.name,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                kind: file.kind,
                ...(file.previewUri ? { previewUri: file.previewUri } : {}),
                status: 'preparing',
              })
            ),
          ]),
        upload,
      })
    },
    [upload]
  )

  const addFiles = useCallback(
    async (files: NativePickedFile[]) =>
      await addFilesForGeneration(files, scopeGeneration.current),
    [addFilesForGeneration]
  )

  const pickFiles = useCallback(
    async (pick: () => Promise<NativePickedFile[]>) => {
      const generation = scopeGeneration.current
      setError(null)
      await runNativeAttachmentPicker({
        generation,
        currentGeneration: () => scopeGeneration.current,
        pick,
        addFiles: addFilesForGeneration,
        onError: setError,
      })
    },
    [addFilesForGeneration]
  )

  const pickDocuments = useCallback(
    async () => await pickFiles(() => input.files.pickDocuments()),
    [input.files, pickFiles]
  )

  const pickImages = useCallback(
    async () => await pickFiles(() => input.files.pickImages()),
    [input.files, pickFiles]
  )

  const retry = useCallback(
    async (id: string) => {
      const source = sources.current.get(id)
      if (source) await upload(source)
    },
    [upload]
  )

  const remove = useCallback((id: string) => {
    sources.current.delete(id)
    attempts.current.delete(id)
    setAttachments((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const clear = useCallback(() => {
    sources.current.clear()
    attempts.current.clear()
    setAttachments([])
    setError(null)
  }, [])
  const clearError = useCallback(() => setError(null), [])

  const visibleState = projectNativeAttachmentScopeState(scopeMatches, attachments, error)
  const visibleAttachments = visibleState.attachments
  const visibleError = visibleState.error
  const readyResources = useMemo<ResourceRef[]>(
    () =>
      visibleAttachments.flatMap((attachment) =>
        attachment.status === 'ready' && attachment.file
          ? [{ kind: 'file' as const, fileId: attachment.file.id }]
          : []
      ),
    [visibleAttachments]
  )

  return {
    attachments: visibleAttachments,
    readyResources,
    uploading: visibleAttachments.some(
      (attachment) => attachment.status === 'preparing' || attachment.status === 'uploading'
    ),
    hasUnresolved: visibleAttachments.some((attachment) => attachment.status !== 'ready'),
    error: visibleError,
    pickDocuments,
    pickImages,
    addFiles,
    retry,
    remove,
    clear,
    clearError,
  }
}
