import { describe, expect, test } from 'bun:test'
import type { FileAttachmentClientLike } from '@opengeni/react/session'
import type { NativeCryptoAdapter, NativeFileAdapter, NativePickedFile } from './adapters'
import {
  addNativeFilesForGeneration,
  prepareNativeAttachmentUpload,
  projectNativeAttachmentScopeState,
  runNativeAttachmentPicker,
  sameNativeAttachmentScope,
  type NativeAttachment,
} from './attachments'

const source: NativePickedFile = {
  id: 'file-1',
  uri: 'file:///image.heic',
  name: 'image.heic',
  contentType: 'image/heic',
  sizeBytes: 3,
  kind: 'image',
}

function fileAdapter(readBytes: NativeFileAdapter['readBytes']): NativeFileAdapter {
  return {
    pickDocuments: async () => [],
    pickImages: async () => [],
    readBytes,
  }
}

describe('prepareNativeAttachmentUpload', () => {
  test('returns the exact native bytes and digest', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => 'uuid',
      sha256Hex: async (value) => {
        expect(value).toBe(bytes)
        return 'a'.repeat(64)
      },
    }

    const prepared = await prepareNativeAttachmentUpload({
      source,
      files: fileAdapter(async () => bytes),
      crypto,
    })

    expect(prepared.bytes).toBe(bytes)
    expect(new Uint8Array(prepared.data)).toEqual(bytes)
    expect(prepared.sha256).toBe('a'.repeat(64))
  })

  test('copies only the exact byte view into the React Native-safe upload body', async () => {
    const backing = new Uint8Array([9, 1, 2, 3, 8])
    const bytes = backing.subarray(1, 4)
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => 'uuid',
      sha256Hex: async () => 'a'.repeat(64),
    }

    const prepared = await prepareNativeAttachmentUpload({
      source,
      files: fileAdapter(async () => bytes),
      crypto,
    })

    expect(new Uint8Array(prepared.data)).toEqual(new Uint8Array([1, 2, 3]))
    expect(prepared.data).not.toBe(backing.buffer)
  })

  test('turns an unreadable native file into a bounded retryable failure', async () => {
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => 'uuid',
      sha256Hex: async () => 'a'.repeat(64),
    }

    await expect(
      prepareNativeAttachmentUpload({
        source,
        files: fileAdapter(async () => await new Promise<Uint8Array>(() => undefined)),
        crypto,
        timeoutMs: 5,
      })
    ).rejects.toThrow('File preparation timed out. Retry the upload.')
  })

  test('turns a stalled digest into a bounded retryable failure', async () => {
    const crypto: NativeCryptoAdapter = {
      randomUUID: () => 'uuid',
      sha256Hex: async () => await new Promise<string>(() => undefined),
    }

    await expect(
      prepareNativeAttachmentUpload({
        source,
        files: fileAdapter(async () => new Uint8Array([1, 2, 3])),
        crypto,
        timeoutMs: 5,
      })
    ).rejects.toThrow('File verification timed out. Retry the upload.')
  })
})

describe('native attachment scope', () => {
  test('treats a session switch as a new attachment scope', () => {
    const client = attachmentClient()
    const base = { client, workspaceId: 'workspace-1', sessionId: 'session-1' }

    expect(sameNativeAttachmentScope(base, base)).toBe(true)
    expect(sameNativeAttachmentScope(base, { ...base, sessionId: 'session-2' })).toBe(false)
    expect(sameNativeAttachmentScope(base, { ...base, workspaceId: 'workspace-2' })).toBe(false)
    expect(sameNativeAttachmentScope(base, { ...base, client: attachmentClient() })).toBe(false)
  })

  test('synchronously hides stale resources and errors while the new session scope resets', () => {
    const staleAttachment: NativeAttachment = {
      id: 'file-1',
      name: 'stale.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      kind: 'document',
      status: 'ready',
    }
    const staleError = new Error('stale')

    expect(projectNativeAttachmentScopeState(false, [staleAttachment], staleError)).toEqual({
      attachments: [],
      error: null,
    })
    expect(projectNativeAttachmentScopeState(true, [staleAttachment], staleError)).toEqual({
      attachments: [staleAttachment],
      error: staleError,
    })
  })

  test('drops a deferred picker result after the session scope changes', async () => {
    let generation = 0
    let resolvePicker: ((files: NativePickedFile[]) => void) | undefined
    const picker = new Promise<NativePickedFile[]>((resolve) => {
      resolvePicker = resolve
    })
    const added: NativePickedFile[][] = []
    const errors: Error[] = []

    const result = runNativeAttachmentPicker({
      generation,
      currentGeneration: () => generation,
      pick: async () => await picker,
      addFiles: async (files) => {
        added.push(files)
      },
      onError: (error) => errors.push(error),
    })

    generation += 1
    resolvePicker?.([source])

    await expect(result).resolves.toBe('stale')
    expect(added).toEqual([])
    expect(errors).toEqual([])
  })

  test('adds picker results only while the originating scope remains current', async () => {
    const added: NativePickedFile[][] = []

    await expect(
      runNativeAttachmentPicker({
        generation: 4,
        currentGeneration: () => 4,
        pick: async () => [source],
        addFiles: async (files, generation) => {
          expect(generation).toBe(4)
          added.push(files)
        },
        onError: () => undefined,
      })
    ).resolves.toBe('added')
    expect(added).toEqual([[source]])
  })

  test('stops serial uploads when the scope changes between files', async () => {
    const secondSource: NativePickedFile = {
      ...source,
      id: 'file-2',
      uri: 'file:///second.heic',
      name: 'second.heic',
    }
    let generation = 4
    const remembered: string[] = []
    const appended: string[][] = []
    const uploads: Array<{ id: string; generation: number }> = []

    await addNativeFilesForGeneration({
      files: [source, secondSource],
      generation,
      currentGeneration: () => generation,
      hasSource: () => false,
      rememberSource: (file) => remembered.push(file.id),
      appendAttachments: (files) => appended.push(files.map((file) => file.id)),
      upload: async (file, originatingGeneration) => {
        uploads.push({ id: file.id, generation: originatingGeneration })
        generation += 1
      },
    })

    expect(remembered).toEqual(['file-1', 'file-2'])
    expect(appended).toEqual([['file-1', 'file-2']])
    expect(uploads).toEqual([{ id: 'file-1', generation: 4 }])
  })
})

function attachmentClient(): FileAttachmentClientLike {
  return {
    uploadFile: async () => await Promise.reject(new Error('not used by scope tests')),
  }
}
