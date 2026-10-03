import type { HumanInputAnswer, HumanInputQuestion, SessionStatus } from '@opengeni/sdk'
import type { ActivityItem, TimelineItem } from '@opengeni/react/session'
import { DEFAULT_OPENGENI_NATIVE_LABELS, type OpenGeniNativeLabels } from './presentation'

export function nativeKnowledgeOutcomeLabel(
  item: Extract<TimelineItem, { kind: 'knowledge' }>,
  labels: OpenGeniNativeLabels
): string {
  return (labels.knowledgeOutcome ?? DEFAULT_OPENGENI_NATIVE_LABELS.knowledgeOutcome)[item.outcome]
}

export type NativeSessionStatusTone = 'neutral' | 'working' | 'attention' | 'failed' | 'complete'

export interface NativeActivityPresentation {
  title: string
  preview: string
  status: string | null
  detail: string | null
  expandedByDefault: boolean
  tone: 'neutral' | 'running' | 'failed'
}

export function nativeSessionStatusTone(status: SessionStatus | null): NativeSessionStatusTone {
  switch (status) {
    case 'queued':
    case 'running':
    case 'recovering':
    case 'waiting_capacity':
      return 'working'
    case 'requires_action':
      return 'attention'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'complete'
    default:
      return 'neutral'
  }
}

export function boundedJson(value: unknown, maximum = 1_200): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2) ?? ''
  } catch {
    serialized = String(value)
  }
  return serialized.length <= maximum ? serialized : `${serialized.slice(0, maximum)}…`
}

function plainTextContent(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+])\s+/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|\s)[*_](?=\S)/g, '$1')
    .replace(/(?<=\S)[*_](?=\s|$|[.,!?;:])/g, '')
    .trim()
}

function normalizedPreview(value: string, maximum = 140): string {
  const normalized = plainTextContent(value).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

function recordPreview(value: object): string {
  for (const key of ['summary', 'message', 'title', 'name', 'status', 'text', 'query', 'cmd']) {
    const candidate: unknown = Reflect.get(value, key)
    if (typeof candidate === 'string') {
      const preview = normalizedPreview(candidate)
      if (preview) return preview
    }
  }
  const keys = Object.keys(value)
  return keys.length > 0 ? keys.slice(0, 4).join(', ') : ''
}

export function inspectableValuePreview(value: unknown): string {
  if (typeof value === 'string') return normalizedPreview(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`
  if (value && typeof value === 'object') return recordPreview(value)
  return ''
}

export function nativeToolDisplayName(name: string): string {
  const boundary = name.indexOf('__')
  const leaf = boundary >= 0 ? name.slice(boundary + 2) : name
  const phrase = leaf.replace(/[_-]+/g, ' ').trim()
  return phrase ? phrase.charAt(0).toLocaleUpperCase() + phrase.slice(1) : name
}

function activityStatus(
  item: Extract<ActivityItem, { status: 'running' | 'complete' | 'failed' | 'cancelled' }>,
  labels: OpenGeniNativeLabels
): {
  status: string | null
  fallbackStatus: string
  expandedByDefault: boolean
  tone: NativeActivityPresentation['tone']
} {
  const fallbackStatus = nativeTimelineStatusLabel(item.status, labels)
  return {
    status: item.status === 'complete' ? null : fallbackStatus,
    fallbackStatus,
    expandedByDefault: item.status === 'failed',
    tone: item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : 'neutral',
  }
}

export function nativeActivityPresentation(
  item: ActivityItem,
  labels: OpenGeniNativeLabels
): NativeActivityPresentation {
  switch (item.kind) {
    case 'agent-message':
      return {
        title: labels.assistant,
        preview: normalizedPreview(item.text),
        status: item.streaming ? labels.statusRunning : null,
        detail: plainTextContent(item.text) || null,
        expandedByDefault: false,
        tone: item.streaming ? 'running' : 'neutral',
      }
    case 'reasoning':
      return {
        title: item.streaming ? labels.thinking : labels.thought,
        preview: normalizedPreview(item.text),
        status: item.streaming ? labels.statusRunning : null,
        detail: plainTextContent(item.text) || null,
        expandedByDefault: false,
        tone: item.streaming ? 'running' : 'neutral',
      }
    case 'tool-call': {
      const outputPreview = inspectableValuePreview(item.output)
      const argumentPreview = inspectableValuePreview(item.arguments)
      const status = activityStatus(item, labels)
      return {
        title: nativeToolDisplayName(item.name),
        preview: outputPreview || argumentPreview || status.fallbackStatus,
        detail: boundedJson({
          input: item.arguments,
          ...(item.output !== undefined ? { result: item.output } : {}),
          ...(item.truncation ? { truncation: item.truncation } : {}),
        }),
        status: status.status,
        expandedByDefault: status.expandedByDefault,
        tone: status.tone,
      }
    }
    case 'worker': {
      const status = activityStatus(item, labels)
      return {
        title: labels.worker,
        preview:
          normalizedPreview(item.prompt ?? item.failure?.message ?? '') || status.fallbackStatus,
        detail: item.failure
          ? boundedJson(item.failure)
          : item.prompt?.trim() || item.workerSessionId || null,
        status: status.status,
        expandedByDefault: status.expandedByDefault,
        tone: status.tone,
      }
    }
    case 'sandbox': {
      const status = activityStatus(item, labels)
      return {
        title: nativeToolDisplayName(item.name || labels.sandbox),
        preview:
          inspectableValuePreview(item.output) ||
          inspectableValuePreview(item.command) ||
          status.fallbackStatus,
        detail: boundedJson({
          ...(item.command ? { command: item.command } : {}),
          ...(item.output ? { output: item.output } : {}),
          ...(item.origin ? { origin: item.origin } : {}),
        }),
        status: status.status,
        expandedByDefault: status.expandedByDefault,
        tone: status.tone,
      }
    }
    case 'startup-phase': {
      const status = activityStatus(item, labels)
      return {
        title: nativeToolDisplayName(item.phase),
        preview: item.outcome ? nativeToolDisplayName(item.outcome) : status.fallbackStatus,
        detail:
          item.durationMs == null
            ? null
            : `${Math.max(0, Math.round(item.durationMs / 100) / 10)}s`,
        status: status.status,
        expandedByDefault: status.expandedByDefault,
        tone: status.tone,
      }
    }
    case 'knowledge':
      return {
        title: nativeKnowledgeOutcomeLabel(item, labels),
        preview: item.filename ?? '',
        status: null,
        detail: item.filename ?? null,
        expandedByDefault: false,
        tone: item.status === 'failed' ? 'failed' : 'neutral',
      }
    case 'memory':
      return {
        title: nativeMemoryActionLabel(item, labels),
        preview: normalizedPreview(item.replacementPreview ?? item.preview),
        status: null,
        detail: item.replacementPreview
          ? boundedJson({ before: item.preview, after: item.replacementPreview })
          : item.preview,
        expandedByDefault: false,
        tone: 'neutral',
      }
    case 'fleet-decision': {
      const summary = nativeFleetDecisionSummary(item, labels)
      return {
        title: labels.fleetDecision,
        preview: summary,
        status: null,
        detail: boundedJson({
          outcome: item.actualOutcome,
          reason: item.actualReason,
          admission: item.admissionOutcome,
          candidates: item.candidateCount,
        }),
        expandedByDefault: false,
        tone: item.actualOutcome === 'waiting' ? 'running' : 'neutral',
      }
    }
  }
}

function formatLabel(template: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce(
    (formatted, [key, value]) => formatted.split(`{${key}}`).join(String(value)),
    template
  )
}

export function formatNativeRelativeTime(
  iso: string,
  labels: Pick<
    OpenGeniNativeLabels,
    'relativeNow' | 'relativeSeconds' | 'relativeMinutes' | 'relativeHours' | 'relativeDays'
  >,
  now: Date = new Date()
): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1_000))
  if (seconds < 10) return labels.relativeNow
  if (seconds < 60) return formatLabel(labels.relativeSeconds, { value: seconds })

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return formatLabel(labels.relativeMinutes, { value: minutes })

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatLabel(labels.relativeHours, { value: hours })

  const days = Math.floor(hours / 24)
  if (days < 14) return formatLabel(labels.relativeDays, { value: days })
  // oxlint-disable-next-line architecture/no-unsafe-date-format -- Timeline age intentionally matches OpenGeni's device-local relative-time formatter; this is not an organization-domain date.
  return new Date(iso).toLocaleDateString()
}

export function nativeTimelineStatusLabel(
  status: 'running' | 'complete' | 'failed' | 'cancelled',
  labels: OpenGeniNativeLabels
): string {
  switch (status) {
    case 'running':
      return labels.statusRunning
    case 'complete':
      return labels.statusComplete
    case 'failed':
      return labels.statusFailed
    case 'cancelled':
      return labels.statusCancelled
  }
}

export function nativeGoalActionLabel(
  action: Extract<TimelineItem, { kind: 'goal' }>['action'],
  labels: OpenGeniNativeLabels
): string {
  return labels.goalAction[action]
}

export function nativeHumanInputRequestPreview(
  requests: readonly {
    questions: readonly Pick<HumanInputQuestion, 'label' | 'prompt'>[]
  }[]
): string {
  return requests
    .flatMap((request) =>
      request.questions.map((question) => question.label?.trim() || question.prompt.trim())
    )
    .filter((label) => label.length > 0)
    .join(' · ')
}

export function nativeHumanInputSummary(
  item: Extract<TimelineItem, { kind: 'human-input' }>,
  labels: OpenGeniNativeLabels
): string {
  const questions = item.questions
    .map((question) => (question.label ? `${question.label}: ${question.prompt}` : question.prompt))
    .join('\n')
  const outcome = labels.humanInputOutcome[item.response.outcome]
  const answers = item.answers
    .map(
      (answer) =>
        `${answer.label}: ${answer.values.join(', ') || labels.humanInputOutcome.answered}`
    )
    .join('\n')

  return [questions, answers ? `${outcome}: ${answers}` : outcome].filter(Boolean).join('\n')
}

export function nativeContextCompactionPhaseLabel(
  phase: Extract<TimelineItem, { kind: 'context-compaction' }>['phase'],
  labels: OpenGeniNativeLabels
): string {
  return labels.contextCompactionPhase[phase]
}

export function nativeMemoryActionLabel(
  item: Extract<TimelineItem, { kind: 'memory' }>,
  labels: OpenGeniNativeLabels
): string {
  if (item.variant === 'saved') return labels.memoryAction.saved
  if (item.replacementPreview) return labels.memoryAction.corrected
  return item.action === 'updated' ? labels.memoryAction.updated : labels.memoryAction.archived
}

export function nativeFleetDecisionSummary(
  item: Extract<TimelineItem, { kind: 'fleet-decision' }>,
  labels: OpenGeniNativeLabels
): string {
  const outcome =
    item.actualOutcome === 'selected' && item.actualCandidateKey
      ? formatLabel(labels.fleetOutcome.selected, { candidate: item.actualCandidateKey })
      : item.actualOutcome === 'waiting'
        ? labels.fleetOutcome.waiting
        : labels.fleetOutcome.none
  const reason = (() => {
    switch (item.actualReason) {
      case 'lease_reused':
        return labels.fleetReason.leaseReused
      case 'pin':
        return labels.fleetReason.pin
      case 'rotation':
        return labels.fleetReason.rotation
      case 'active':
        return labels.fleetReason.active
      case 'all_capped':
        return labels.fleetReason.allCapped
      case 'none':
        return labels.fleetReason.none
    }
  })()
  return `${outcome} · ${reason}`
}

export function timelineAccessibilityLabel(
  item: TimelineItem,
  labels: OpenGeniNativeLabels
): string {
  switch (item.kind) {
    case 'user-message':
      return `${labels.user}: ${item.text}`
    case 'human-input':
      return `${labels.humanInputAsked}: ${nativeHumanInputSummary(item, labels)}`
    case 'agent-message':
      return `${labels.assistant}: ${item.text}`
    case 'reasoning':
      return `${labels.reasoning}: ${item.text}`
    case 'tool-call':
      return `${labels.tool} ${item.name}, ${nativeTimelineStatusLabel(item.status, labels)}`
    case 'worker':
      return `${labels.worker}, ${nativeTimelineStatusLabel(item.status, labels)}${item.prompt ? `: ${item.prompt}` : ''}`
    case 'sandbox':
      return `${labels.sandbox} ${item.name}, ${nativeTimelineStatusLabel(item.status, labels)}`
    case 'startup-phase':
      return `${labels.activity}, ${nativeTimelineStatusLabel(item.status, labels)}`
    case 'session-status':
      return nativeSessionStatusLabel(item.status, labels)
    case 'goal':
      return `${nativeGoalActionLabel(item.action, labels)}${item.text ? `: ${item.text}` : ''}`
    case 'notice':
      return item.text
    case 'context-compaction':
      return nativeContextCompactionPhaseLabel(item.phase, labels)
    case 'machine-input-batch':
      return formatLabel(labels.machineUpdates, { value: item.members.length })
    case 'auth-needed':
      return formatLabel(labels.connectionRequired, { provider: item.providerDomain })
    case 'knowledge':
      return `${nativeKnowledgeOutcomeLabel(item, labels)}${item.filename ? `: ${item.filename}` : ''}`
    case 'memory':
      return `${nativeMemoryActionLabel(item, labels)}: ${item.replacementPreview ?? item.preview}`
    case 'fleet-decision':
      return `${labels.fleetDecision}: ${nativeFleetDecisionSummary(item, labels)}`
    case 'turn-end':
      return `${labels.turn}, ${nativeTimelineStatusLabel(item.outcome, labels)}`
    case 'worker-completion':
      return item.text
  }
}

export function nativeSessionStatusLabel(
  status: SessionStatus,
  labels: OpenGeniNativeLabels
): string {
  switch (status) {
    case 'queued':
      return labels.statusQueued
    case 'running':
      return labels.statusRunning
    case 'recovering':
      return labels.statusRecovering
    case 'waiting_capacity':
      return labels.statusWaitingCapacity
    case 'idle':
      return labels.statusIdle
    case 'requires_action':
      return labels.statusRequiresAction
    case 'failed':
      return labels.statusFailed
    case 'cancelled':
      return labels.statusCancelled
  }
}

export function validateHumanInputAnswers(
  questions: readonly HumanInputQuestion[],
  drafts: Readonly<Record<string, NativeHumanInputDraft>>
): { answers: HumanInputAnswer[]; valid: boolean } {
  const answers: HumanInputAnswer[] = []
  let valid = true

  for (const question of questions) {
    const draft = drafts[question.id] ?? emptyHumanInputDraft()
    const values =
      question.kind === 'text'
        ? draft.values.filter((value) => value.trim().length > 0)
        : draft.values
    const other = draft.otherSelected ? draft.other.trim() : ''
    const supplied = values.length + (other.length > 0 ? 1 : 0)

    if (question.kind !== 'text' && draft.otherSelected && other.length === 0) valid = false
    if (question.required && supplied === 0) valid = false
    if (question.kind !== 'text') {
      const minimum = question.validation?.minSelections
      const maximum = question.kind === 'single_select' ? 1 : question.validation?.maxSelections
      if (minimum != null && supplied < minimum) valid = false
      if (maximum != null && supplied > maximum) valid = false
    }
    if (supplied > 0) {
      answers.push({
        questionId: question.id,
        values,
        ...(other ? { other } : {}),
      })
    }
  }

  return { answers, valid }
}

export interface NativeHumanInputDraft {
  values: string[]
  other: string
  otherSelected: boolean
}

export function emptyHumanInputDraft(): NativeHumanInputDraft {
  return { values: [], other: '', otherSelected: false }
}
