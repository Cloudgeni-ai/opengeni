import { describe, expect, test } from 'bun:test'
import type { HumanInputQuestion } from '@opengeni/sdk'
import type { ActivityItem, TimelineItem } from '@opengeni/react/session'
import {
  boundedJson,
  formatNativeRelativeTime,
  inspectableValuePreview,
  nativeActivityPresentation,
  nativeSessionStatusTone,
  nativeToolDisplayName,
  timelineAccessibilityLabel,
  nativeHumanInputRequestPreview,
  validateHumanInputAnswers,
  type NativeHumanInputDraft,
} from './view-model'
import { DEFAULT_OPENGENI_NATIVE_LABELS } from './presentation'

describe('native session view-models', () => {
  test('presents folded assistant commentary as progress, never as reasoning', () => {
    for (const streaming of [true, false]) {
      const item = {
        kind: 'agent-message',
        id: 'progress-1',
        turnId: 'turn-1',
        phase: 'commentary',
        text: '**Checking** the project list',
        streaming,
        occurredAt: '2026-09-28T00:00:00.000Z',
      } satisfies ActivityItem
      expect(nativeActivityPresentation(item, DEFAULT_OPENGENI_NATIVE_LABELS)).toEqual({
        title: DEFAULT_OPENGENI_NATIVE_LABELS.assistant,
        preview: 'Checking the project list',
        status: streaming ? DEFAULT_OPENGENI_NATIVE_LABELS.statusRunning : null,
        detail: 'Checking the project list',
        expandedByDefault: false,
        tone: streaming ? 'running' : 'neutral',
      })
    }
  })

  test('handles knowledge timeline outcomes without calling pending content published', () => {
    for (const outcome of ['published', 'pending', 'rejected', 'archived', 'failed'] as const) {
      const item = {
        kind: 'knowledge',
        id: 'knowledge-event',
        turnId: null,
        status: outcome === 'failed' ? 'failed' : 'complete',
        outcome,
        filename: 'Notes.pdf',
        occurredAt: '2026-09-12T12:00:00.000Z',
      } satisfies ActivityItem
      const label = DEFAULT_OPENGENI_NATIVE_LABELS.knowledgeOutcome[outcome]
      expect(nativeActivityPresentation(item, DEFAULT_OPENGENI_NATIVE_LABELS)).toMatchObject({
        title: label,
        preview: 'Notes.pdf',
        tone: outcome === 'failed' ? 'failed' : 'neutral',
      })
      expect(timelineAccessibilityLabel(item, DEFAULT_OPENGENI_NATIVE_LABELS)).toBe(
        `${label}: Notes.pdf`
      )
    }
  })

  test('maps work and attention statuses without inventing authorization state', () => {
    expect(nativeSessionStatusTone('running')).toBe('working')
    expect(nativeSessionStatusTone('requires_action')).toBe('attention')
    expect(nativeSessionStatusTone('failed')).toBe('failed')
  })

  test('bounds inspectable tool payloads', () => {
    expect(boundedJson({ value: 'abcdef' }, 8)).toBe('{\n  "val…')
  })

  test('removes Markdown decoration from compact activity text', () => {
    const item = {
      kind: 'reasoning',
      id: 'reasoning-markdown',
      turnId: 'turn-1',
      text: '**Planning tool search** with [project context](https://example.com)',
      streaming: false,
      occurredAt: '2026-08-24T12:00:00.000Z',
    } satisfies ActivityItem

    expect(nativeActivityPresentation(item, DEFAULT_OPENGENI_NATIVE_LABELS)).toMatchObject({
      preview: 'Planning tool search with project context',
      detail: 'Planning tool search with project context',
    })
  })

  test('gives unknown tools a readable title, preview, status, and inspectable fallback', () => {
    const item = {
      kind: 'tool-call',
      id: 'tool-1',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'opengeni__exec_command',
      arguments: { cmd: 'git status --short' },
      output: { message: 'Working tree clean' },
      raw: null,
      status: 'complete',
      occurredAt: '2026-08-24T12:00:00.000Z',
    } satisfies ActivityItem

    expect(nativeToolDisplayName(item.name)).toBe('Exec command')
    expect(inspectableValuePreview(item.output)).toBe('Working tree clean')
    expect(nativeActivityPresentation(item, DEFAULT_OPENGENI_NATIVE_LABELS)).toEqual({
      title: 'Exec command',
      preview: 'Working tree clean',
      status: null,
      detail:
        '{\n  "input": {\n    "cmd": "git status --short"\n  },\n  "result": {\n    "message": "Working tree clean"\n  }\n}',
      expandedByDefault: false,
      tone: 'neutral',
    })
  })

  test('provides a non-empty presentation for every activity kind', () => {
    const occurredAt = '2026-08-24T12:00:00.000Z'
    const items = [
      {
        kind: 'agent-message',
        id: 'commentary-1',
        turnId: 'turn-1',
        text: 'Checking project details',
        phase: 'commentary',
        streaming: true,
        occurredAt,
      },
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        turnId: 'turn-1',
        text: 'Checking the project list',
        streaming: true,
        occurredAt,
      },
      {
        kind: 'tool-call',
        id: 'tool-1',
        turnId: 'turn-1',
        callId: 'call-1',
        name: 'search_projects',
        arguments: { query: 'active' },
        output: undefined,
        raw: null,
        status: 'running',
        occurredAt,
      },
      {
        kind: 'worker',
        id: 'worker-1',
        turnId: 'turn-1',
        callId: 'call-2',
        action: 'spawn',
        prompt: 'Inspect project data',
        workerSessionId: 'worker-session-1',
        failure: null,
        status: 'complete',
        occurredAt,
      },
      {
        kind: 'sandbox',
        id: 'sandbox-1',
        turnId: 'turn-1',
        name: 'exec_command',
        command: 'pwd',
        output: '/workspace',
        status: 'complete',
        occurredAt,
      },
      {
        kind: 'startup-phase',
        id: 'startup-1',
        turnId: 'turn-1',
        phase: 'tools',
        status: 'complete',
        startedAt: occurredAt,
        completedAt: occurredAt,
        durationMs: 240,
        outcome: null,
        occurredAt,
      },
      {
        kind: 'memory',
        id: 'memory-1',
        turnId: 'turn-1',
        variant: 'saved',
        memoryKind: 'semantic',
        preview: 'The project is active',
        memoryId: 'memory-record-1',
        occurredAt,
      },
      {
        kind: 'fleet-decision',
        id: 'fleet-1',
        turnId: 'turn-1',
        policyVersion: 'adaptive-shadow-v1',
        actualOutcome: 'waiting',
        actualCandidateKey: null,
        actualReason: 'all_capped',
        shadowOutcome: 'none',
        shadowCandidateKey: null,
        shadowReason: 'no_eligible_candidate',
        comparison: 'different_outcome',
        confidence: 'high',
        admissionOutcome: 'pace',
        admissionReason: 'capacity_saturated',
        borrowedIdleCapacity: false,
        borrowedOverlayCapacity: false,
        strandedEligibleCount: 0,
        candidateCount: 0,
        truncatedCandidateCount: 0,
        scoreRowsTruncatedCount: 0,
        scores: [],
        occurredAt,
      },
    ] satisfies ActivityItem[]

    const presentations = items.map((item) =>
      nativeActivityPresentation(item, DEFAULT_OPENGENI_NATIVE_LABELS)
    )
    expect(
      presentations.every(
        (presentation) => presentation.title.length > 0 && presentation.preview.length > 0
      )
    ).toBe(true)
  })

  test('matches the official compact relative-time thresholds', () => {
    const now = new Date('2026-08-12T12:00:00.000Z')
    expect(
      formatNativeRelativeTime('2026-08-12T11:59:55.000Z', DEFAULT_OPENGENI_NATIVE_LABELS, now)
    ).toBe('now')
    expect(
      formatNativeRelativeTime('2026-08-12T11:59:18.000Z', DEFAULT_OPENGENI_NATIVE_LABELS, now)
    ).toBe('42s')
    expect(
      formatNativeRelativeTime('2026-08-12T11:53:00.000Z', DEFAULT_OPENGENI_NATIVE_LABELS, now)
    ).toBe('7m')
    expect(
      formatNativeRelativeTime('2026-08-12T09:00:00.000Z', DEFAULT_OPENGENI_NATIVE_LABELS, now)
    ).toBe('3h')
    expect(
      formatNativeRelativeTime('2026-08-10T12:00:00.000Z', DEFAULT_OPENGENI_NATIVE_LABELS, now)
    ).toBe('2d')
  })

  test('uses host labels for timeline accessibility instead of English enum names', () => {
    const labels = {
      ...DEFAULT_OPENGENI_NATIVE_LABELS,
      tool: 'Verktøy',
      statusComplete: 'Fullført',
      machineUpdates: 'Maskinoppdateringer: {value}',
    }

    expect(
      timelineAccessibilityLabel(
        {
          kind: 'tool-call',
          id: 'tool-1',
          turnId: 'turn-1',
          callId: 'call-1',
          name: 'search',
          arguments: {},
          output: {},
          raw: null,
          status: 'complete',
          occurredAt: '2026-08-12T12:00:00.000Z',
        },
        labels
      )
    ).toBe('Verktøy search, Fullført')
    expect(
      timelineAccessibilityLabel(
        {
          kind: 'machine-input-batch',
          id: 'batch-1',
          turnId: 'turn-1',
          members: [],
          occurredAt: '2026-08-12T12:00:00.000Z',
        },
        labels
      )
    ).toBe('Maskinoppdateringer: 0')
    expect(
      timelineAccessibilityLabel(
        {
          kind: 'startup-phase',
          id: 'startup-1',
          turnId: 'turn-1',
          phase: 'provider_first_byte',
          status: 'complete',
          startedAt: '2026-08-12T12:00:00.000Z',
          completedAt: '2026-08-12T12:00:01.000Z',
          durationMs: 1_000,
          outcome: null,
          occurredAt: '2026-08-12T12:00:01.000Z',
        },
        labels
      )
    ).toBe('Activity, Fullført')
  })

  test('preserves localized goal, compaction, memory, and fleet discriminants', () => {
    const labels = {
      ...DEFAULT_OPENGENI_NATIVE_LABELS,
      goalAction: {
        ...DEFAULT_OPENGENI_NATIVE_LABELS.goalAction,
        held: 'Mål satt på vent',
      },
      contextCompactionPhase: {
        ...DEFAULT_OPENGENI_NATIVE_LABELS.contextCompactionPhase,
        skipped: 'Komprimering hoppet over',
      },
      memoryAction: {
        ...DEFAULT_OPENGENI_NATIVE_LABELS.memoryAction,
        archived: 'Minne arkivert',
      },
      fleetDecision: 'Kapasitetsvalg',
      fleetOutcome: {
        ...DEFAULT_OPENGENI_NATIVE_LABELS.fleetOutcome,
        waiting: 'Venter på kapasitet',
      },
      fleetReason: {
        ...DEFAULT_OPENGENI_NATIVE_LABELS.fleetReason,
        allCapped: 'Alle abonnementer nådde grensen',
      },
    }

    const goal = {
      kind: 'goal',
      id: 'goal-1',
      action: 'held',
      text: 'Venter på et valg',
      occurredAt: '2026-08-12T12:00:00.000Z',
    } satisfies TimelineItem
    const compaction = {
      kind: 'context-compaction',
      id: 'compaction-1',
      turnId: 'turn-1',
      phase: 'skipped',
      trigger: 'overflow',
      estimatedTokensBefore: 100,
      estimatedTokensAfter: null,
      skipReason: 'replacement_not_smaller',
      providerRejection: null,
      implementation: 'test',
      occurredAt: '2026-08-12T12:00:00.000Z',
    } satisfies TimelineItem
    const memory = {
      kind: 'memory',
      id: 'memory-event-1',
      turnId: 'turn-1',
      variant: 'corrected',
      memoryKind: 'semantic',
      preview: 'Gammelt minne',
      action: 'archived',
      memoryId: 'memory-1',
      occurredAt: '2026-08-12T12:00:00.000Z',
    } satisfies TimelineItem
    const fleet = {
      kind: 'fleet-decision',
      id: 'fleet-1',
      turnId: 'turn-1',
      policyVersion: 'adaptive-shadow-v1',
      actualOutcome: 'waiting',
      actualCandidateKey: null,
      actualReason: 'all_capped',
      shadowOutcome: 'none',
      shadowCandidateKey: null,
      shadowReason: 'no_eligible_candidate',
      comparison: 'different_outcome',
      confidence: 'high',
      admissionOutcome: 'pace',
      admissionReason: 'capacity_saturated',
      borrowedIdleCapacity: false,
      borrowedOverlayCapacity: false,
      strandedEligibleCount: 0,
      candidateCount: 2,
      truncatedCandidateCount: 0,
      scoreRowsTruncatedCount: 0,
      scores: [],
      occurredAt: '2026-08-12T12:00:00.000Z',
    } satisfies TimelineItem

    expect(timelineAccessibilityLabel(goal, labels)).toBe('Mål satt på vent: Venter på et valg')
    expect(timelineAccessibilityLabel(compaction, labels)).toBe('Komprimering hoppet over')
    expect(timelineAccessibilityLabel(memory, labels)).toBe('Minne arkivert: Gammelt minne')
    expect(timelineAccessibilityLabel(fleet, labels)).toBe(
      'Kapasitetsvalg: Venter på kapasitet · Alle abonnementer nådde grensen'
    )
  })

  test('keeps settled structured input visible and accessible', () => {
    const labels = {
      ...DEFAULT_OPENGENI_NATIVE_LABELS,
      humanInputAsked: 'Agenten spurte',
      humanInputOutcome: {
        ...DEFAULT_OPENGENI_NATIVE_LABELS.humanInputOutcome,
        answered: 'Du svarte',
      },
    }
    const item = {
      kind: 'human-input',
      id: 'human-input-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      questions: [
        {
          id: 'trade',
          kind: 'single_select',
          label: 'Fag',
          prompt: 'Velg fag',
          options: [{ id: 'plumbing', label: 'Rør' }],
          required: true,
          allowOther: false,
          validation: null,
        },
      ],
      response: {
        outcome: 'answered',
        answers: [{ questionId: 'trade', values: ['Rør'] }],
      },
      answers: [{ questionId: 'trade', label: 'Fag', prompt: 'Velg fag', values: ['Rør'] }],
      occurredAt: '2026-08-25T12:00:00.000Z',
    } satisfies TimelineItem

    expect(timelineAccessibilityLabel(item, labels)).toBe(
      'Agenten spurte: Fag: Velg fag\nDu svarte: Fag: Rør'
    )
  })

  test('previews pending structured questions for the collapsed workspace header', () => {
    expect(
      nativeHumanInputRequestPreview([
        {
          questions: [
            { label: 'Customer', prompt: 'Who is the customer?' },
            { label: 'Status', prompt: 'What status should it have?' },
          ],
        },
      ])
    ).toBe('Customer · Status')
    expect(
      nativeHumanInputRequestPreview([
        {
          questions: [{ prompt: 'Add a note' }],
        },
      ])
    ).toBe('Add a note')
  })

  test('validates required and bounded structured answers', () => {
    const questions: HumanInputQuestion[] = [
      {
        id: 'choice',
        kind: 'multi_select',
        prompt: 'Choose',
        options: [],
        required: true,
        allowOther: false,
        validation: { minSelections: 1, maxSelections: 2 },
      },
    ]
    expect(validateHumanInputAnswers(questions, {}).valid).toBe(false)
    expect(
      validateHumanInputAnswers(questions, {
        choice: draft({ values: ['one', 'two'] }),
      }).valid
    ).toBe(true)
    expect(
      validateHumanInputAnswers(questions, {
        choice: draft({ values: ['one', 'two', 'three'] }),
      }).valid
    ).toBe(false)
  })

  test('matches official Other selection semantics for single-select questions', () => {
    const questions: HumanInputQuestion[] = [
      {
        id: 'choice',
        kind: 'single_select',
        prompt: 'Choose',
        options: [{ id: 'one', label: 'One' }],
        required: true,
        allowOther: true,
        validation: null,
      },
    ]
    expect(
      validateHumanInputAnswers(questions, {
        choice: draft({ otherSelected: true }),
      }).valid
    ).toBe(false)
    expect(
      validateHumanInputAnswers(questions, {
        choice: draft({ otherSelected: true, other: 'Custom' }),
      })
    ).toEqual({
      valid: true,
      answers: [{ questionId: 'choice', values: [], other: 'Custom' }],
    })
  })
})

function draft(overrides: Partial<NativeHumanInputDraft>): NativeHumanInputDraft {
  return { values: [], other: '', otherSelected: false, ...overrides }
}


test('presents assistant commentary as activity while preserving its text', () => {
  const item = {
    kind: 'agent-message', id: 'commentary', turnId: 'turn',
    text: '**Checking** project details', phase: 'commentary', streaming: true,
    occurredAt: '2026-09-29T12:00:00Z',
  } satisfies ActivityItem
  expect(nativeActivityPresentation(item, DEFAULT_OPENGENI_NATIVE_LABELS)).toMatchObject({
    title: DEFAULT_OPENGENI_NATIVE_LABELS.assistant,
    preview: 'Checking project details', tone: 'running',
    status: DEFAULT_OPENGENI_NATIVE_LABELS.statusRunning,
  })
  expect(nativeActivityPresentation({ ...item, streaming: false }, DEFAULT_OPENGENI_NATIVE_LABELS)).toMatchObject({ tone: 'neutral', status: null })
})
