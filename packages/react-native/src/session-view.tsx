import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import type {
  HumanInputAnswer,
  HumanInputQuestion,
  SessionHumanInputRequest,
  SessionTurn,
} from '@opengeni/sdk'
import type {
  ActivityItem,
  TimelineGroup,
  TimelineItem,
  ToolCallItem,
} from '@opengeni/react/session'
import type { OpenGeniNativeSessionController } from './use-native-session'
import type { NativeFileAttachmentsResult } from './attachments'
import {
  DEFAULT_OPENGENI_NATIVE_LABELS,
  DEFAULT_OPENGENI_NATIVE_THEME,
  type OpenGeniNativeLabels,
  type OpenGeniNativeTheme,
} from './presentation'
import {
  boundedJson,
  emptyHumanInputDraft,
  formatNativeRelativeTime,
  nativeActivityPresentation,
  nativeContextCompactionPhaseLabel,
  nativeFleetDecisionSummary,
  nativeGoalActionLabel,
  nativeHumanInputRequestPreview,
  nativeHumanInputSummary,
  nativeMemoryActionLabel,
  nativeKnowledgeOutcomeLabel,
  nativeSessionStatusLabel,
  nativeTimelineStatusLabel,
  timelineAccessibilityLabel,
  validateHumanInputAnswers,
  type NativeHumanInputDraft,
} from './view-model'

export type NativeToolRenderer = (
  item: ToolCallItem,
  context: { theme: OpenGeniNativeTheme; labels: OpenGeniNativeLabels; compact: boolean }
) => ReactNode

export type NativeMessageRenderer = (
  text: string,
  role: 'user' | 'assistant' | 'reasoning',
  context: { theme: OpenGeniNativeTheme }
) => ReactNode

export interface NativeTurnSummaryContext {
  items: readonly ActivityItem[]
  toolCalls: readonly ToolCallItem[]
  outcome: Extract<TimelineGroup, { kind: 'turn' }>['outcome']
  failureText: string | undefined
  durationMs: number | undefined
  settled: boolean
  contextCompactionCount: number
}

export interface NativeTurnSummaryResult {
  content: string
  accessibilityLabel?: string
  duration?: string | null
}

export type NativeTurnSummaryRenderer = (
  context: NativeTurnSummaryContext
) => NativeTurnSummaryResult | null

export interface NativeComposerActionContext {
  accessory?: ReactNode
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
  busy: boolean
  paused: boolean
  runActive: boolean
  canSubmit: boolean
  draftSaving: boolean
  submitLabel: string
  onAttachDocument(): void
  onAttachImage(): void
  onTogglePause(): void
  onSubmit(): void
}

export type NativeComposerActionRenderer = (context: NativeComposerActionContext) => ReactNode

export interface NativeComposerRenderContext extends NativeComposerActionContext {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
}

export type NativeComposerRenderer = (context: NativeComposerRenderContext) => ReactNode

export interface NativeComposerSurfaceContext {
  children: ReactNode
  style: StyleProp<ViewStyle>
}

export type NativeComposerSurfaceRenderer = (context: NativeComposerSurfaceContext) => ReactNode

export interface OpenGeniNativeSessionViewProps {
  controller: OpenGeniNativeSessionController
  theme?: OpenGeniNativeTheme
  labels?: Partial<OpenGeniNativeLabels>
  header?: ReactNode
  composerAccessory?: ReactNode
  composerSafeAreaInsets?: { bottom: number; left: number; right: number }
  renderComposer?: NativeComposerRenderer
  renderComposerActions?: NativeComposerActionRenderer
  renderComposerSurface?: NativeComposerSurfaceRenderer
  renderTool?: NativeToolRenderer
  renderMessage?: NativeMessageRenderer
  summarizeTurn?: NativeTurnSummaryRenderer
  formatError?: (error: Error) => string
  keyboardVerticalOffset?: number
  testID?: string
}

export function OpenGeniNativeSessionView({
  controller,
  theme = DEFAULT_OPENGENI_NATIVE_THEME,
  labels: labelOverrides,
  header,
  composerAccessory,
  composerSafeAreaInsets = { bottom: 0, left: 0, right: 0 },
  renderComposer,
  renderComposerActions,
  renderComposerSurface,
  renderTool,
  renderMessage,
  summarizeTurn,
  formatError,
  keyboardVerticalOffset = 0,
  testID,
}: OpenGeniNativeSessionViewProps) {
  const labels = useMemo(
    () => ({ ...DEFAULT_OPENGENI_NATIVE_LABELS, ...labelOverrides }),
    [labelOverrides]
  )
  const listRef = useRef<FlatList<TimelineGroup>>(null)
  const followTail = useRef(true)
  const humanInputRequests = controller.humanInput.requests
  const humanInputRequestKey = humanInputRequests.map((request) => request.id).join('|')
  const [humanInputOpen, setHumanInputOpen] = useState(true)
  const humanInputExpanded = humanInputRequests.length > 0 && humanInputOpen
  const auxiliarySurfacesVisible =
    controller.queue.queue.length > 0 ||
    (controller.queue.effectiveControl?.state === 'paused' &&
      controller.queue.effectiveControl.resumeOptions.length > 1)

  useEffect(() => {
    if (humanInputRequestKey) setHumanInputOpen(true)
  }, [humanInputRequestKey])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    followTail.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 96
  }, [])

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      testID={testID}
    >
      {header}
      <View style={styles.body}>
        <View style={styles.timelineColumn}>
          <View style={styles.timelineStage}>
            <ConnectionBanner
              controller={controller}
              formatError={formatError}
              labels={labels}
              theme={theme}
            />
            <View style={humanInputExpanded ? styles.timelineHidden : styles.timeline}>
              <FlatList
                contentContainerStyle={[
                  styles.timelineContent,
                  renderComposer ? styles.timelineContentNativeComposer : null,
                  controller.timelineGroups.length === 0 && styles.emptyTimeline,
                ]}
                data={controller.timelineGroups}
                keyboardDismissMode="interactive"
                keyboardShouldPersistTaps="handled"
                keyExtractor={timelineGroupKey}
                ListHeaderComponent={
                  controller.hasOlder ? (
                    <ActionButton
                      label={controller.loadingOlder ? labels.loadingEarlier : labels.loadEarlier}
                      onPress={() => void controller.loadOlder()}
                      theme={theme}
                      disabled={controller.loadingOlder}
                      variant="quiet"
                    />
                  ) : null
                }
                ListEmptyComponent={
                  controller.initialLoading ? (
                    <ActivityIndicator color={theme.colors.accent} />
                  ) : (
                    <View accessible accessibilityRole="summary" style={styles.emptyState}>
                      <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
                        {labels.emptyTitle}
                      </Text>
                      <Text
                        style={[styles.emptyDescription, { color: theme.colors.secondaryText }]}
                      >
                        {labels.emptyDescription}
                      </Text>
                    </View>
                  )
                }
                onContentSizeChange={() => {
                  if (followTail.current) listRef.current?.scrollToEnd({ animated: true })
                }}
                onScroll={onScroll}
                ref={listRef}
                renderItem={({ item }) => (
                  <TimelineGroupRow
                    group={item}
                    labels={labels}
                    renderMessage={renderMessage}
                    renderTool={renderTool}
                    summarizeTurn={summarizeTurn}
                    theme={theme}
                  />
                )}
                scrollEventThrottle={32}
                style={styles.timeline}
              />
            </View>
            {humanInputRequests.length > 0 ? (
              <HumanInputWorkspace
                expanded={humanInputOpen}
                labels={labels}
                onRespond={(requestId, response) =>
                  void controller.humanInput.respond(requestId, response)
                }
                onToggle={() => setHumanInputOpen((current) => !current)}
                requests={humanInputRequests}
                respondingRequestId={controller.humanInput.respondingRequestId}
                theme={theme}
              />
            ) : null}
            {controller.approvals.length > 0 ? (
              <View pointerEvents="box-none" style={styles.approvalOverlay}>
                <ApprovalSurface controller={controller} labels={labels} theme={theme} />
              </View>
            ) : null}
          </View>
          {auxiliarySurfacesVisible ? (
            <ScrollView
              contentContainerStyle={styles.sessionSurfacesContent}
              keyboardShouldPersistTaps="handled"
              style={styles.sessionSurfaces}
            >
              <SessionSurfaces controller={controller} labels={labels} theme={theme} />
            </ScrollView>
          ) : null}
          <View
            style={[
              styles.composerDock,
              {
                backgroundColor: theme.colors.background,
                borderTopColor: theme.colors.border,
                borderTopWidth: StyleSheet.hairlineWidth,
                paddingBottom: Math.max(8, composerSafeAreaInsets.bottom),
                paddingLeft: Math.max(12, composerSafeAreaInsets.left + 12),
                paddingRight: Math.max(12, composerSafeAreaInsets.right + 12),
              },
            ]}
          >
            <OpenGeniNativeAttachmentStrip
              attachments={controller.attachments}
              labels={labels}
              onRemoveRestoredResource={controller.composer.removeRestoredResource}
              restoredResources={controller.composer.restoredResources}
              theme={theme}
            />
            <Composer
              accessory={composerAccessory}
              controller={controller}
              labels={labels}
              renderActions={renderComposerActions}
              renderComposer={renderComposer}
              renderSurface={renderComposerSurface}
              theme={theme}
            />
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

function timelineGroupKey(group: TimelineGroup): string {
  return group.kind === 'item' ? `item-${group.item.id}` : group.id
}

function TimelineGroupRow({
  group,
  labels,
  renderMessage,
  renderTool,
  summarizeTurn,
  theme,
}: {
  group: TimelineGroup
  labels: OpenGeniNativeLabels
  renderMessage?: NativeMessageRenderer
  renderTool?: NativeToolRenderer
  summarizeTurn?: NativeTurnSummaryRenderer
  theme: OpenGeniNativeTheme
}) {
  switch (group.kind) {
    case 'item':
      return (
        <TimelineRow
          item={group.item}
          labels={labels}
          renderMessage={renderMessage}
          renderTool={renderTool}
          theme={theme}
        />
      )
    case 'activity':
      return (
        <ActivityRail
          items={group.items}
          labels={labels}
          renderMessage={renderMessage}
          renderTool={renderTool}
          theme={theme}
        />
      )
    case 'turn':
      return (
        <SettledTurn
          group={group}
          labels={labels}
          renderMessage={renderMessage}
          renderTool={renderTool}
          summarizeTurn={summarizeTurn}
          theme={theme}
        />
      )
  }
}

function SettledTurn({
  group,
  labels,
  renderMessage,
  renderTool,
  summarizeTurn,
  theme,
}: {
  group: Extract<TimelineGroup, { kind: 'turn' }>
  labels: OpenGeniNativeLabels
  renderMessage?: NativeMessageRenderer
  renderTool?: NativeToolRenderer
  summarizeTurn?: NativeTurnSummaryRenderer
  theme: OpenGeniNativeTheme
}) {
  const [open, setOpen] = useState(group.outcome === 'failed')
  const items = useMemo(() => collectTurnActivityItems(group.groups), [group.groups])
  const durationMs = turnDurationMs(group.startedAt, group.endedAt)
  const summary = summarizeTurn?.({
    items,
    toolCalls: items.filter((item): item is ToolCallItem => item.kind === 'tool-call'),
    outcome: group.outcome,
    failureText: group.failureText,
    durationMs,
    settled: items.every((item) => !activityItemRunning(item)),
    contextCompactionCount: group.contextCompactionCount ?? 0,
  }) ?? {
    content: `${labels.activity} · ${items.length}`,
    accessibilityLabel: `${labels.activity}, ${items.length}`,
  }
  return (
    <View style={styles.turnGroup}>
      <Pressable
        accessibilityLabel={summary.accessibilityLabel ?? summary.content}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [
          styles.turnSummary,
          {
            backgroundColor:
              group.outcome === 'failed' ? theme.colors.dangerSurface : theme.colors.elevated,
            borderColor: group.outcome === 'failed' ? theme.colors.danger : theme.colors.border,
            opacity: pressed ? 0.72 : 1,
          },
        ]}
      >
        <Text style={[styles.turnChevron, { color: theme.colors.mutedText }]}>
          {open ? '⌄' : '›'}
        </Text>
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[
            styles.turnOutcome,
            {
              color:
                group.outcome === 'failed'
                  ? theme.colors.danger
                  : group.outcome === 'complete'
                    ? theme.colors.success
                    : theme.colors.mutedText,
            },
          ]}
        >
          {group.outcome === 'complete' ? '✓' : group.outcome === 'failed' ? '!' : '–'}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            styles.turnSummaryText,
            {
              color: group.outcome === 'failed' ? theme.colors.danger : theme.colors.secondaryText,
            },
          ]}
        >
          {summary.content}
        </Text>
        {summary.duration ? (
          <Text style={[styles.turnDuration, { color: theme.colors.mutedText }]}>
            {summary.duration}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={[styles.turnRail, { borderLeftColor: theme.colors.border }]}>
          {group.groups.map((child) => (
            <TimelineGroupRow
              group={child}
              key={timelineGroupKey(child)}
              labels={labels}
              renderMessage={renderMessage}
              renderTool={renderTool}
              summarizeTurn={summarizeTurn}
              theme={theme}
            />
          ))}
          {group.failureText ? (
            <Text style={[styles.secondaryText, { color: theme.colors.danger }]}>
              {group.failureText}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function collectTurnActivityItems(groups: readonly TimelineGroup[]): ActivityItem[] {
  return groups.flatMap((group): ActivityItem[] => {
    switch (group.kind) {
      case 'activity':
        return group.items
      case 'turn':
        return collectTurnActivityItems(group.groups)
      case 'item':
        return isActivityItem(group.item) ? [group.item] : []
    }
  })
}

function isActivityItem(item: TimelineItem): item is ActivityItem {
  return (
    (item.kind === 'agent-message' && item.phase === 'commentary') ||
    item.kind === 'reasoning' ||
    item.kind === 'tool-call' ||
    item.kind === 'worker' ||
    item.kind === 'sandbox' ||
    item.kind === 'memory' ||
    item.kind === 'fleet-decision'
  )
}

function activityItemRunning(item: ActivityItem): boolean {
  return (
    ((item.kind === 'reasoning' || item.kind === 'agent-message') && item.streaming) ||
    ((item.kind === 'tool-call' || item.kind === 'worker' || item.kind === 'sandbox') &&
      item.status === 'running')
  )
}

function turnDurationMs(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
}

function ActivityRail({
  items,
  labels,
  renderMessage,
  renderTool,
  theme,
}: {
  items: ActivityItem[]
  labels: OpenGeniNativeLabels
  renderMessage?: NativeMessageRenderer
  renderTool?: NativeToolRenderer
  theme: OpenGeniNativeTheme
}) {
  return (
    <View style={[styles.activityRail, { borderLeftColor: theme.colors.border }]}>
      {items.map((item) => (
        <TimelineRow
          compactActivity
          item={item}
          key={item.id}
          labels={labels}
          renderMessage={renderMessage}
          renderTool={renderTool}
          theme={theme}
        />
      ))}
    </View>
  )
}

function ConnectionBanner({
  controller,
  formatError,
  labels,
  theme,
}: {
  controller: OpenGeniNativeSessionController
  formatError?: (error: Error) => string
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  const message = !controller.active
    ? labels.offlinePaused
    : controller.connectionState === 'reconnecting'
      ? labels.reconnecting
      : controller.connectionState === 'connecting'
        ? labels.connecting
        : null
  const error = controller.error
  if (!message && !error) return null
  const displayMessage = error ? (formatError?.(error) ?? labels.error) : message

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.banner,
        {
          backgroundColor: error ? theme.colors.dangerSurface : theme.colors.elevated,
        },
      ]}
    >
      <Text
        numberOfLines={3}
        style={[
          styles.bannerText,
          { color: error ? theme.colors.danger : theme.colors.secondaryText },
        ]}
      >
        {displayMessage}
      </Text>
      {error ? (
        <ActionButton
          label={labels.retry}
          onPress={() => void controller.refresh()}
          theme={theme}
          variant="quiet"
        />
      ) : null}
    </View>
  )
}

function TimelineRow({
  compactActivity = false,
  item,
  labels,
  renderMessage,
  renderTool,
  theme,
}: {
  compactActivity?: boolean
  item: TimelineItem
  labels: OpenGeniNativeLabels
  renderMessage?: NativeMessageRenderer
  renderTool?: NativeToolRenderer
  theme: OpenGeniNativeTheme
}) {
  if (item.kind === 'tool-call' && renderTool) {
    const rendered = renderTool(item, { compact: compactActivity, labels, theme })
    if (rendered !== null && rendered !== undefined) return <>{rendered}</>
  }

  if (item.kind === 'user-message' || item.kind === 'agent-message') {
    const user = item.kind === 'user-message'
    const role = user ? 'user' : 'assistant'
    return (
      <View
        accessible
        accessibilityLabel={timelineAccessibilityLabel(item, labels)}
        style={[styles.messageRow, user ? styles.userMessageRow : styles.agentMessageRow]}
      >
        <View
          style={[
            styles.messageBubble,
            user ? styles.userMessageBubble : styles.agentMessage,
            {
              backgroundColor: user ? theme.colors.userBubble : 'transparent',
              borderColor: user ? theme.colors.border : 'transparent',
            },
          ]}
        >
          {renderMessage ? (
            renderMessage(item.text, role, { theme })
          ) : (
            <Text
              selectable
              style={[
                styles.messageText,
                { color: user ? theme.colors.userBubbleText : theme.colors.text },
              ]}
            >
              {item.text}
            </Text>
          )}
          {item.kind === 'agent-message' && item.streaming ? (
            <ActivityIndicator color={theme.colors.accent} size="small" />
          ) : null}
        </View>
      </View>
    )
  }

  if (item.kind === 'reasoning') {
    if (compactActivity) {
      return (
        <ReasoningDisclosure
          item={item}
          labels={labels}
          renderMessage={renderMessage}
          theme={theme}
        />
      )
    }
    return (
      <TimelineCard item={item} labels={labels} theme={theme} title={labels.reasoning}>
        {renderMessage ? (
          renderMessage(item.text, 'reasoning', { theme })
        ) : (
          <Text selectable style={[styles.secondaryText, { color: theme.colors.secondaryText }]}>
            {item.text}
          </Text>
        )}
      </TimelineCard>
    )
  }

  if (item.kind === 'notice') {
    return <NoticeRow item={item} labels={labels} theme={theme} />
  }

  if (item.kind === 'session-status') {
    return <SessionStatusRow item={item} labels={labels} theme={theme} />
  }

  if (item.kind === 'tool-call') {
    return (
      <NativeActivityDisclosure
        compact={compactActivity}
        item={item}
        labels={labels}
        theme={theme}
      />
    )
  }

  if (isActivityItem(item)) {
    return (
      <NativeActivityDisclosure
        compact={compactActivity}
        item={item}
        labels={labels}
        theme={theme}
      />
    )
  }

  const title = timelineTitle(item, labels)
  const detail = timelineSummary(item, labels)
  if (compactActivity) {
    return (
      <View
        accessible
        accessibilityLabel={timelineAccessibilityLabel(item, labels)}
        style={styles.step}
      >
        <Text style={[styles.stepLabel, { color: theme.colors.mutedText }]}>{title}</Text>
        {detail ? (
          <Text selectable style={[styles.secondaryText, { color: theme.colors.secondaryText }]}>
            {detail}
          </Text>
        ) : null}
      </View>
    )
  }
  return (
    <TimelineCard item={item} labels={labels} theme={theme} title={title}>
      {detail ? (
        <Text selectable style={[styles.secondaryText, { color: theme.colors.secondaryText }]}>
          {detail}
        </Text>
      ) : null}
    </TimelineCard>
  )
}

function NativeActivityDisclosure({
  compact,
  item,
  labels,
  theme,
}: {
  compact: boolean
  item: Exclude<ActivityItem, { kind: 'reasoning' }>
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  const presentation = nativeActivityPresentation(item, labels)
  const [open, setOpen] = useState(presentation.expandedByDefault)
  const expandable = Boolean(presentation.detail)
  const foreground =
    presentation.tone === 'failed'
      ? theme.colors.danger
      : presentation.tone === 'running'
        ? theme.colors.accent
        : theme.colors.mutedText
  const technical = item.kind === 'tool-call' || item.kind === 'sandbox'

  return (
    <View
      style={[
        styles.activityDisclosure,
        !compact && styles.activityDisclosureCard,
        !compact && {
          backgroundColor: theme.colors.surface,
          borderColor: presentation.tone === 'failed' ? theme.colors.danger : theme.colors.border,
        },
      ]}
    >
      <Pressable
        accessible
        accessibilityLabel={timelineAccessibilityLabel(item, labels)}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
        disabled={!expandable}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [
          styles.activityDisclosureHeader,
          { opacity: pressed && expandable ? 0.68 : 1 },
        ]}
      >
        <Text style={[styles.activityDisclosureChevron, { color: theme.colors.mutedText }]}>
          {expandable ? (open ? '⌄' : '›') : '·'}
        </Text>
        <View style={[styles.activityStatusDot, { backgroundColor: foreground }]} />
        <Text
          numberOfLines={1}
          style={[
            styles.activityDisclosureTitle,
            { color: presentation.tone === 'failed' ? theme.colors.danger : theme.colors.text },
          ]}
        >
          {presentation.title}
        </Text>
        {!open && presentation.preview ? (
          <Text
            numberOfLines={1}
            style={[styles.activityDisclosurePreview, { color: theme.colors.mutedText }]}
          >
            {presentation.preview}
          </Text>
        ) : null}
        {presentation.status ? (
          <Text numberOfLines={1} style={[styles.activityDisclosureStatus, { color: foreground }]}>
            {presentation.status}
          </Text>
        ) : null}
      </Pressable>
      {open && presentation.detail ? (
        <View style={styles.activityDisclosureBody}>
          <Text
            selectable
            style={[
              technical ? styles.codeText : styles.secondaryText,
              { color: theme.colors.secondaryText },
            ]}
          >
            {presentation.detail}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function timelineTitle(
  item: Exclude<
    TimelineItem,
    { kind: 'user-message' | 'agent-message' | 'reasoning' | 'tool-call' }
  >,
  labels: OpenGeniNativeLabels
): string {
  switch (item.kind) {
    case 'worker':
    case 'worker-completion':
      return labels.worker
    case 'sandbox':
      return item.name
    case 'startup-phase':
      return labels.activity
    case 'session-status':
      return nativeSessionStatusLabel(item.status, labels)
    case 'human-input':
      return labels.humanInputAsked
    case 'goal':
      return nativeGoalActionLabel(item.action, labels)
    case 'context-compaction':
      return nativeContextCompactionPhaseLabel(item.phase, labels)
    case 'memory':
      return nativeMemoryActionLabel(item, labels)
    case 'knowledge':
      return nativeKnowledgeOutcomeLabel(item, labels)
    case 'fleet-decision':
      return labels.fleetDecision
    case 'turn-end':
      return labels.turn
    case 'notice':
    case 'machine-input-batch':
    case 'auth-needed':
      return labels.activity
  }
}

function ReasoningDisclosure({
  item,
  labels,
  renderMessage,
  theme,
}: {
  item: Extract<TimelineItem, { kind: 'reasoning' }>
  labels: OpenGeniNativeLabels
  renderMessage?: NativeMessageRenderer
  theme: OpenGeniNativeTheme
}) {
  const [open, setOpen] = useState(false)
  const presentation = nativeActivityPresentation(item, labels)
  const { preview, title } = presentation

  return (
    <View style={styles.disclosure}>
      <Pressable
        accessibilityLabel={`${title}: ${preview}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [
          styles.disclosureHeader,
          { backgroundColor: pressed ? theme.colors.elevated : 'transparent' },
        ]}
      >
        <Text style={[styles.disclosureChevron, { color: theme.colors.mutedText }]}>
          {open ? '⌄' : '›'}
        </Text>
        <Text style={[styles.disclosureIcon, { color: theme.colors.mutedText }]}>◌</Text>
        <Text
          numberOfLines={1}
          style={[
            styles.disclosureTitle,
            {
              color: theme.colors.mutedText,
              fontStyle: item.streaming ? 'normal' : 'italic',
              fontWeight: item.streaming ? '600' : '400',
            },
          ]}
        >
          {title}
        </Text>
        {!open ? (
          <Text
            numberOfLines={1}
            style={[styles.disclosurePreview, { color: theme.colors.mutedText }]}
          >
            {preview}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={styles.disclosureBody}>
          {renderMessage ? (
            renderMessage(item.text, 'reasoning', { theme })
          ) : (
            <Text selectable style={[styles.secondaryText, { color: theme.colors.secondaryText }]}>
              {presentation.detail}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  )
}

function NoticeRow({
  item,
  labels,
  theme,
}: {
  item: Extract<TimelineItem, { kind: 'notice' }>
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const action = item.action
  const failed = item.tone === 'failed'
  const waiting = item.tone === 'waiting' || item.tone === 'input'
  const foreground = failed
    ? theme.colors.danger
    : waiting
      ? theme.colors.warning
      : theme.colors.secondaryText
  const background = failed
    ? theme.colors.dangerSurface
    : waiting
      ? theme.colors.warningSurface
      : theme.colors.elevated

  return (
    <View
      accessibilityLiveRegion="polite"
      accessible
      accessibilityLabel={timelineAccessibilityLabel(item, labels)}
      style={[styles.notice, { backgroundColor: background, borderColor: foreground }]}
    >
      <Text style={[styles.noticeIcon, { color: foreground }]}>!</Text>
      <View style={styles.noticeContent}>
        <Text selectable style={[styles.secondaryText, { color: foreground }]}>
          {item.text}
        </Text>
        {item.details ? (
          <View style={styles.noticeDetails}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: detailsOpen }}
              onPress={() => setDetailsOpen((current) => !current)}
            >
              <Text style={[styles.noticeAction, { color: foreground }]}>
                {detailsOpen ? '⌄' : '›'} {item.details.label}
              </Text>
            </Pressable>
            {detailsOpen ? (
              <Text selectable style={[styles.codeText, { color: foreground }]}>
                {boundedJson(item.details.value)}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {action ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(action.url)}
          style={styles.noticeLink}
        >
          <Text style={[styles.noticeAction, { color: foreground }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function SessionStatusRow({
  item,
  labels,
  theme,
}: {
  item: Extract<TimelineItem, { kind: 'session-status' }>
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  const label = nativeSessionStatusLabel(item.status, labels).toLocaleLowerCase()
  const dotColor = sessionStatusColor(item.status, theme)
  const relativeTime = formatNativeRelativeTime(item.occurredAt, labels)

  return (
    <View
      accessibilityRole="text"
      accessible
      accessibilityLabel={`${label}${relativeTime ? `, ${relativeTime}` : ''}`}
      style={styles.sessionStatus}
    >
      <View style={[styles.sessionStatusRule, { backgroundColor: theme.colors.border }]} />
      <View style={styles.sessionStatusLabel}>
        <View style={[styles.sessionStatusDot, { backgroundColor: dotColor }]} />
        <Text style={[styles.sessionStatusText, { color: theme.colors.mutedText }]}>
          {label}
          {relativeTime ? ` · ${relativeTime}` : ''}
        </Text>
      </View>
      <View style={[styles.sessionStatusRule, { backgroundColor: theme.colors.border }]} />
    </View>
  )
}

function sessionStatusColor(
  status: Extract<TimelineItem, { kind: 'session-status' }>['status'],
  theme: OpenGeniNativeTheme
): string {
  switch (status) {
    case 'failed':
      return theme.colors.danger
    case 'requires_action':
    case 'waiting_capacity':
      return theme.colors.warning
    case 'idle':
      return theme.colors.success
    case 'running':
    case 'recovering':
      return theme.colors.accent
    default:
      return theme.colors.mutedText
  }
}

function TimelineCard({
  children,
  item,
  labels,
  theme,
  title,
}: {
  children: ReactNode
  item: TimelineItem
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
  title: string
}) {
  return (
    <View
      accessible
      accessibilityLabel={timelineAccessibilityLabel(item, labels)}
      style={[
        styles.timelineCard,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.cardTitle, { color: theme.colors.text }]}>{title}</Text>
      {children}
    </View>
  )
}

function timelineSummary(
  item: Exclude<
    TimelineItem,
    { kind: 'user-message' | 'agent-message' | 'reasoning' | 'tool-call' }
  >,
  labels: OpenGeniNativeLabels
): string {
  switch (item.kind) {
    case 'worker':
      return item.prompt ?? nativeTimelineStatusLabel(item.status, labels)
    case 'worker-completion':
      return item.text
    case 'sandbox':
      return item.output || item.command || nativeTimelineStatusLabel(item.status, labels)
    case 'startup-phase':
      return nativeTimelineStatusLabel(item.status, labels)
    case 'session-status':
      return nativeSessionStatusLabel(item.status, labels)
    case 'human-input':
      return nativeHumanInputSummary(item, labels)
    case 'goal':
      return item.text ?? ''
    case 'notice':
      return item.text
    case 'context-compaction':
      return ''
    case 'machine-input-batch':
      return item.members.map((member) => member.summary).join('\n')
    case 'auth-needed':
      return item.providerDomain
    case 'memory':
      return item.replacementPreview ?? item.preview
    case 'knowledge':
      return item.filename ?? ''
    case 'fleet-decision':
      return nativeFleetDecisionSummary(item, labels)
    case 'turn-end':
      return item.failureText ?? nativeTimelineStatusLabel(item.outcome, labels)
  }
}

function ApprovalSurface({
  controller,
  labels,
  theme,
}: {
  controller: OpenGeniNativeSessionController
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  return (
    <View
      pointerEvents="auto"
      style={[
        styles.approvalSurface,
        { backgroundColor: theme.colors.warningSurface, borderColor: theme.colors.warning },
      ]}
    >
      <Text style={[styles.actionTitle, { color: theme.colors.text }]}>
        {labels.approvalsTitle}
      </Text>
      {controller.approvals.map((approval) => (
        <View key={approval.id} style={styles.approvalItem}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>{approval.name}</Text>
          <Text
            numberOfLines={3}
            selectable
            style={[styles.codeText, { color: theme.colors.secondaryText }]}
          >
            {boundedJson(approval.arguments)}
          </Text>
          <View style={styles.buttonRow}>
            <ActionButton
              label={labels.deny}
              onPress={() => void controller.control.reject(approval.id)}
              theme={theme}
              variant="danger"
              disabled={controller.control.responding}
            />
            <ActionButton
              label={labels.approve}
              onPress={() => void controller.control.approve(approval.id)}
              theme={theme}
              disabled={controller.control.responding}
            />
          </View>
        </View>
      ))}
    </View>
  )
}

function SessionSurfaces({
  controller,
  labels,
  theme,
}: {
  controller: OpenGeniNativeSessionController
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  return (
    <View style={styles.actionSurfaces}>
      {controller.queue.effectiveControl?.state === 'paused' &&
      controller.queue.effectiveControl.resumeOptions.length > 1 ? (
        <View style={styles.actionGroup}>
          <Text style={[styles.actionTitle, { color: theme.colors.text }]}>{labels.resume}</Text>
          {controller.queue.effectiveControl.resumeOptions
            .filter((option) => option.scope !== 'selected')
            .map((option) => (
              <View
                key={`${option.scope}:${option.targetId ?? 'current'}`}
                style={[
                  styles.actionCard,
                  {
                    backgroundColor: theme.colors.warningSurface,
                    borderColor: theme.colors.warning,
                  },
                ]}
              >
                <Text style={[styles.secondaryText, { color: theme.colors.text }]}>
                  {option.impactCopy}
                </Text>
                <ActionButton
                  label={labels.resume}
                  onPress={() => void controller.composer.resumeScope(option)}
                  theme={theme}
                  disabled={controller.composer.resuming}
                />
              </View>
            ))}
        </View>
      ) : null}
      {controller.queue.queue.length > 0 ? (
        <QueueSurface controller={controller} labels={labels} theme={theme} />
      ) : null}
    </View>
  )
}

function QueueSurface({
  controller,
  labels,
  theme,
}: {
  controller: OpenGeniNativeSessionController
  labels: OpenGeniNativeLabels
  theme: OpenGeniNativeTheme
}) {
  const [open, setOpen] = useState(false)
  const edit = async (turn: SessionTurn) => {
    if (controller.composer.hasDraftContent()) return
    const draft = await controller.queue.editTurn(turn.id, {
      expectedDraftRevision: controller.composer.draftRevision,
      replaceDraft: true,
    })
    if (draft) controller.composer.applyDraft(draft)
  }
  const move = (index: number, direction: -1 | 1) => {
    const turn = controller.queue.queue[index]
    if (!turn) return
    const beforeTurnId =
      direction < 0
        ? (controller.queue.queue[index - 1]?.id ?? null)
        : (controller.queue.queue[index + 2]?.id ?? null)
    void controller.queue.moveTurn(turn.id, beforeTurnId)
  }

  return (
    <View
      style={[
        styles.queueSurface,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Pressable
        accessibilityLabel={`${labels.queueTitle}, ${controller.queue.queue.length}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.queueDisclosure, { opacity: pressed ? 0.72 : 1 }]}
      >
        <Text style={[styles.queueChevron, { color: theme.colors.mutedText }]}>
          {open ? '⌄' : '›'}
        </Text>
        <Text numberOfLines={1} style={[styles.queueTitle, { color: theme.colors.text }]}>
          {controller.queue.queue.length} {labels.queueTitle}
        </Text>
        {!open ? (
          <Text numberOfLines={1} style={[styles.queuePreview, { color: theme.colors.mutedText }]}>
            {controller.queue.queue[0]?.prompt}
          </Text>
        ) : null}
      </Pressable>
      {open
        ? controller.queue.queue.map((turn, index) => (
            <View key={turn.id} style={[styles.queueRow, { borderTopColor: theme.colors.border }]}>
              <Text numberOfLines={3} style={[styles.queuePrompt, { color: theme.colors.text }]}>
                {turn.prompt}
              </Text>
              <View style={styles.queueActions}>
                {index > 0 ? (
                  <ActionButton
                    compact
                    label={labels.moveEarlier}
                    onPress={() => move(index, -1)}
                    theme={theme}
                    variant="quiet"
                    disabled={controller.queue.mutating}
                  />
                ) : null}
                {index < controller.queue.queue.length - 1 ? (
                  <ActionButton
                    compact
                    label={labels.moveLater}
                    onPress={() => move(index, 1)}
                    theme={theme}
                    variant="quiet"
                    disabled={controller.queue.mutating}
                  />
                ) : null}
                <ActionButton
                  compact
                  label={labels.edit}
                  onPress={() => void edit(turn)}
                  theme={theme}
                  variant="quiet"
                  disabled={controller.composer.hasDraftContent() || controller.queue.mutating}
                />
                <ActionButton
                  compact
                  label={labels.runNext}
                  onPress={() => void controller.queue.steerTurn(turn.id)}
                  theme={theme}
                  variant="quiet"
                  disabled={controller.queue.mutating}
                />
                <ActionButton
                  compact
                  label={labels.remove}
                  onPress={() => void controller.queue.removeTurn(turn.id)}
                  theme={theme}
                  variant="danger"
                  disabled={controller.queue.mutating}
                />
              </View>
            </View>
          ))
        : null}
    </View>
  )
}

function HumanInputWorkspace({
  expanded,
  labels,
  onRespond,
  onToggle,
  requests,
  respondingRequestId,
  theme,
}: {
  expanded: boolean
  labels: OpenGeniNativeLabels
  onRespond: (
    requestId: string,
    response: { outcome: 'answered'; answers: HumanInputAnswer[] } | { outcome: 'skipped' }
  ) => void
  onToggle: () => void
  requests: readonly SessionHumanInputRequest[]
  respondingRequestId: string | null
  theme: OpenGeniNativeTheme
}) {
  const preview = nativeHumanInputRequestPreview(requests)
  const identityLabel = preview ? `${labels.questionsTitle}: ${preview}` : labels.questionsTitle

  return (
    <View
      style={expanded ? styles.humanInputWorkspaceExpanded : styles.humanInputWorkspaceCollapsed}
      testID="opengeni-human-input-workspace"
    >
      <Pressable
        accessibilityLabel={identityLabel}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [
          styles.humanInputDisclosure,
          { backgroundColor: pressed ? theme.colors.elevated : 'transparent' },
        ]}
      >
        <Text style={[styles.disclosureChevron, { color: theme.colors.mutedText }]}>
          {expanded ? '⌄' : '›'}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.humanInputDisclosureTitle, { color: theme.colors.text }]}
        >
          {labels.questionsTitle}
        </Text>
        {!expanded && preview ? (
          <Text
            numberOfLines={1}
            style={[styles.disclosurePreview, { color: theme.colors.mutedText }]}
          >
            {preview}
          </Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <ScrollView
          contentContainerStyle={styles.humanInputWorkspaceBody}
          keyboardShouldPersistTaps="handled"
          style={styles.humanInputWorkspaceScroll}
        >
          {requests.map((request) => (
            <HumanInputCard
              key={request.id}
              labels={labels}
              onRespond={(response) => onRespond(request.id, response)}
              request={request}
              responding={respondingRequestId === request.id}
              theme={theme}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}

function HumanInputCard({
  labels,
  onRespond,
  request,
  responding,
  theme,
}: {
  labels: OpenGeniNativeLabels
  onRespond: (
    response: { outcome: 'answered'; answers: HumanInputAnswer[] } | { outcome: 'skipped' }
  ) => void
  request: SessionHumanInputRequest
  responding: boolean
  theme: OpenGeniNativeTheme
}) {
  const [drafts, setDrafts] = useState<Record<string, NativeHumanInputDraft>>({})
  const projection = validateHumanInputAnswers(request.questions, drafts)

  const update = (
    questionId: string,
    updater: (current: NativeHumanInputDraft) => NativeHumanInputDraft
  ) => {
    setDrafts((current) => ({
      ...current,
      [questionId]: updater(current[questionId] ?? emptyHumanInputDraft()),
    }))
  }

  return (
    <View style={styles.actionGroup}>
      <View
        style={[
          styles.actionCard,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        {request.questions.map((question) => (
          <QuestionField
            draft={drafts[question.id]}
            key={question.id}
            labels={labels}
            onChange={(next) => update(question.id, () => next)}
            question={question}
            theme={theme}
          />
        ))}
        <View style={styles.buttonRow}>
          {request.allowSkip ? (
            <ActionButton
              label={labels.skip}
              onPress={() => onRespond({ outcome: 'skipped' })}
              theme={theme}
              variant="quiet"
              disabled={responding}
            />
          ) : null}
          <ActionButton
            label={labels.submitAnswers}
            onPress={() => onRespond({ outcome: 'answered', answers: projection.answers })}
            theme={theme}
            disabled={!projection.valid || responding}
          />
        </View>
      </View>
    </View>
  )
}

function QuestionField({
  draft,
  labels,
  onChange,
  question,
  theme,
}: {
  draft: NativeHumanInputDraft | undefined
  labels: OpenGeniNativeLabels
  onChange: (draft: NativeHumanInputDraft) => void
  question: HumanInputQuestion
  theme: OpenGeniNativeTheme
}) {
  const current = draft ?? emptyHumanInputDraft()
  const values = current.values
  const toggle = (id: string) => {
    const next =
      question.kind === 'single_select'
        ? [id]
        : values.includes(id)
          ? values.filter((value) => value !== id)
          : [...values, id]
    onChange({
      ...current,
      values: next,
      ...(question.kind === 'single_select' ? { otherSelected: false } : {}),
    })
  }

  return (
    <View style={styles.question}>
      <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
        {question.label ?? question.prompt}
        {question.required ? ` · ${labels.required}` : ''}
      </Text>
      {question.label ? (
        <Text style={[styles.secondaryText, { color: theme.colors.secondaryText }]}>
          {question.prompt}
        </Text>
      ) : null}
      {question.helpText ? (
        <Text style={[styles.helpText, { color: theme.colors.mutedText }]}>
          {question.helpText}
        </Text>
      ) : null}
      {question.kind === 'text' ? (
        <TextInput
          accessibilityLabel={question.label ?? question.prompt}
          multiline
          onChangeText={(text) => onChange({ ...current, values: text ? [text] : [] })}
          style={[
            styles.questionInput,
            {
              backgroundColor: theme.colors.background,
              borderColor: theme.colors.border,
              color: theme.colors.text,
            },
          ]}
          value={values[0] ?? ''}
        />
      ) : (
        <View style={styles.optionList}>
          {question.options.map((option) => {
            const selected = values.includes(option.id)
            return (
              <Pressable
                accessibilityRole={question.kind === 'single_select' ? 'radio' : 'checkbox'}
                accessibilityState={{ checked: selected }}
                key={option.id}
                onPress={() => toggle(option.id)}
                style={[
                  styles.option,
                  {
                    backgroundColor: selected ? theme.colors.elevated : theme.colors.background,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                  },
                ]}
              >
                <Text style={[styles.optionLabel, { color: theme.colors.text }]}>
                  {option.label}
                </Text>
                {option.description ? (
                  <Text style={[styles.helpText, { color: theme.colors.secondaryText }]}>
                    {option.description}
                  </Text>
                ) : null}
              </Pressable>
            )
          })}
        </View>
      )}
      {question.kind !== 'text' && question.allowOther ? (
        <View
          style={[
            styles.option,
            {
              backgroundColor: current.otherSelected
                ? theme.colors.elevated
                : theme.colors.background,
              borderColor: current.otherSelected ? theme.colors.accent : theme.colors.border,
            },
          ]}
        >
          <Pressable
            accessibilityRole={question.kind === 'single_select' ? 'radio' : 'checkbox'}
            accessibilityState={{ checked: current.otherSelected }}
            onPress={() =>
              onChange({
                ...current,
                otherSelected: !current.otherSelected,
                ...(question.kind === 'single_select' && !current.otherSelected
                  ? { values: [] }
                  : {}),
              })
            }
            style={styles.otherOptionToggle}
          >
            <Text style={[styles.optionLabel, { color: theme.colors.text }]}>{labels.other}</Text>
          </Pressable>
          <TextInput
            accessibilityLabel={labels.other}
            editable={current.otherSelected}
            onChangeText={(other) => onChange({ ...current, other })}
            placeholder={labels.other}
            placeholderTextColor={theme.colors.mutedText}
            style={[
              styles.otherInput,
              {
                backgroundColor: theme.colors.background,
                borderColor: theme.colors.border,
                color: theme.colors.text,
                opacity: current.otherSelected ? 1 : 0.5,
              },
            ]}
            value={current.other}
          />
        </View>
      ) : null}
    </View>
  )
}

export function OpenGeniNativeAttachmentStrip({
  attachments,
  labels,
  onRemoveRestoredResource,
  restoredResources = [],
  theme,
}: {
  attachments: NativeFileAttachmentsResult
  labels: OpenGeniNativeLabels
  onRemoveRestoredResource?: (index: number) => void
  restoredResources?: readonly unknown[]
  theme: OpenGeniNativeTheme
}) {
  const error = attachments.error
  if (attachments.attachments.length === 0 && restoredResources.length === 0 && !error) return null

  return (
    <ScrollView
      contentContainerStyle={styles.attachmentStrip}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
    >
      {error ? (
        <View
          style={[
            styles.attachmentChip,
            { backgroundColor: theme.colors.dangerSurface, borderColor: theme.colors.danger },
          ]}
        >
          <Text style={[styles.attachmentName, { color: theme.colors.danger }]}>
            {labels.attachmentError}
          </Text>
          <ActionButton
            label={labels.dismiss}
            onPress={() => attachments.clearError()}
            theme={theme}
            variant="quiet"
          />
        </View>
      ) : null}
      {attachments.attachments.map((attachment) => (
        <View
          key={attachment.id}
          style={[
            styles.attachmentChip,
            { backgroundColor: theme.colors.elevated, borderColor: theme.colors.border },
          ]}
        >
          <Text numberOfLines={1} style={[styles.attachmentName, { color: theme.colors.text }]}>
            {attachment.name}
          </Text>
          <Text
            style={[
              styles.helpText,
              {
                color:
                  attachment.status === 'failed' ? theme.colors.danger : theme.colors.mutedText,
              },
            ]}
          >
            {attachment.status === 'preparing'
              ? labels.preparingAttachment
              : attachment.status === 'uploading'
                ? labels.uploading
                : attachment.status === 'failed'
                  ? labels.uploadFailed
                  : formatBytes(attachment.sizeBytes)}
          </Text>
          <View style={styles.buttonRow}>
            {attachment.status === 'failed' ? (
              <ActionButton
                label={labels.retryUpload}
                onPress={() => void attachments.retry(attachment.id)}
                theme={theme}
                variant="quiet"
              />
            ) : null}
            <ActionButton
              label={labels.removeAttachment}
              onPress={() => attachments.remove(attachment.id)}
              theme={theme}
              variant="quiet"
            />
          </View>
        </View>
      ))}
      {restoredResources.map((_resource, index) => (
        <View
          key={`restored-${index}`}
          style={[
            styles.attachmentChip,
            { backgroundColor: theme.colors.elevated, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.attachmentName, { color: theme.colors.text }]}>
            {labels.restoredAttachment}
          </Text>
          <ActionButton
            label={labels.removeAttachment}
            onPress={() => onRemoveRestoredResource?.(index)}
            theme={theme}
            variant="quiet"
            disabled={!onRemoveRestoredResource}
          />
        </View>
      ))}
    </ScrollView>
  )
}

function Composer({
  accessory,
  controller,
  labels,
  renderActions,
  renderComposer,
  renderSurface,
  theme,
}: {
  accessory?: ReactNode
  controller: OpenGeniNativeSessionController
  labels: OpenGeniNativeLabels
  renderActions?: NativeComposerActionRenderer
  renderComposer?: NativeComposerRenderer
  renderSurface?: NativeComposerSurfaceRenderer
  theme: OpenGeniNativeTheme
}) {
  const paused = controller.queue.effectiveControl?.state === 'paused'
  const busy =
    controller.composer.sending || controller.composer.pausing || controller.composer.resuming
  const actionContext: NativeComposerActionContext = {
    accessory,
    labels,
    theme,
    busy,
    paused,
    runActive: controller.runActive,
    canSubmit: controller.composer.canSend && !busy,
    draftSaving: controller.composer.draftSaving,
    submitLabel: labels.send,
    onAttachDocument: () => void controller.attachments.pickDocuments(),
    onAttachImage: () => void controller.attachments.pickImages(),
    onTogglePause: () => void (paused ? controller.composer.resume() : controller.composer.pause()),
    onSubmit: () => void controller.composer.send(),
  }
  const composerContext: NativeComposerRenderContext = {
    ...actionContext,
    value: controller.composer.value,
    onChangeText: controller.composer.setValue,
    placeholder: labels.composerPlaceholder,
  }

  const content = (
    <>
      {controller.composer.draftConflict ? (
        <View style={[styles.draftConflict, { backgroundColor: theme.colors.warningSurface }]}>
          <Text style={[styles.secondaryText, { color: theme.colors.warning }]}>
            {labels.draftConflict}
          </Text>
          <View style={styles.buttonRow}>
            <ActionButton
              label={labels.useRemote}
              onPress={() => void controller.composer.resolveDraftConflict('use_remote')}
              theme={theme}
              variant="quiet"
            />
            <ActionButton
              label={labels.keepMine}
              onPress={() => void controller.composer.resolveDraftConflict('keep_mine')}
              theme={theme}
              variant="quiet"
            />
          </View>
        </View>
      ) : null}
      {renderComposer ? (
        renderComposer(composerContext)
      ) : (
        <View style={renderActions ? styles.composerRow : styles.composerStack}>
          <TextInput
            accessibilityLabel={labels.composerPlaceholder}
            blurOnSubmit={false}
            multiline
            onChangeText={controller.composer.setValue}
            placeholder={labels.composerPlaceholder}
            placeholderTextColor={theme.colors.mutedText}
            style={[styles.composerInput, { color: theme.colors.text }]}
            value={controller.composer.value}
          />
          {renderActions ? (
            renderActions(actionContext)
          ) : (
            <DefaultComposerActions {...actionContext} />
          )}
        </View>
      )}
    </>
  )

  if (renderComposer) {
    return <>{content}</>
  }

  if (renderSurface) {
    return renderSurface({ children: content, style: styles.composerContainer })
  }

  return (
    <View
      style={[
        styles.composerContainer,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      {content}
    </View>
  )
}

function DefaultComposerActions(context: NativeComposerActionContext) {
  return (
    <View style={styles.composerToolbar}>
      <View style={styles.buttonWrap}>
        <ActionButton
          accessibilityLabel={context.labels.attachDocument}
          label="＋"
          onPress={() => context.onAttachDocument()}
          theme={context.theme}
          variant="quiet"
          disabled={context.busy}
        />
        <ActionButton
          accessibilityLabel={context.labels.attachImage}
          label="▧"
          onPress={() => context.onAttachImage()}
          theme={context.theme}
          variant="quiet"
          disabled={context.busy}
        />
        {context.accessory}
      </View>
      <View style={styles.buttonWrap}>
        <ActionButton
          label={context.paused ? context.labels.resume : context.labels.pause}
          onPress={() => context.onTogglePause()}
          theme={context.theme}
          variant="quiet"
          disabled={context.busy}
        />
        <ActionButton
          label={context.submitLabel}
          onPress={() => context.onSubmit()}
          theme={context.theme}
          disabled={!context.canSubmit}
        />
      </View>
    </View>
  )
}

function ActionButton({
  accessibilityLabel,
  compact = false,
  disabled = false,
  label,
  onPress,
  theme,
  variant = 'primary',
}: {
  accessibilityLabel?: string
  compact?: boolean
  disabled?: boolean
  label: string
  onPress: () => void
  theme: OpenGeniNativeTheme
  variant?: 'primary' | 'quiet' | 'danger'
}) {
  const colors =
    variant === 'primary'
      ? {
          background: theme.colors.accent,
          foreground: theme.colors.accentForeground,
          border: theme.colors.accent,
        }
      : variant === 'danger'
        ? {
            background: 'transparent',
            foreground: theme.colors.danger,
            border: theme.colors.danger,
          }
        : {
            background: 'transparent',
            foreground: theme.colors.secondaryText,
            border: theme.colors.border,
          }
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compactButton,
        {
          backgroundColor: colors.background,
          borderColor: colors.border,
          opacity: disabled ? 0.42 : pressed ? 0.72 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          compact && styles.compactButtonText,
          { color: colors.foreground },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function formatBytes(value: number | null): string {
  if (value === null) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  timelineColumn: { flex: 1, minWidth: 0 },
  timelineStage: { flex: 1, minHeight: 0 },
  timeline: { flex: 1 },
  timelineHidden: { flex: 0, height: 0, overflow: 'hidden', opacity: 0 },
  timelineContent: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    gap: 12,
    padding: 16,
    paddingBottom: 132,
  },
  timelineContentNativeComposer: {
    paddingBottom: 16,
  },
  emptyTimeline: { flexGrow: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  emptyDescription: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  banner: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  messageRow: { width: '100%' },
  userMessageRow: { alignItems: 'flex-end' },
  agentMessageRow: { alignItems: 'flex-start' },
  messageBubble: {
    gap: 8,
  },
  userMessageBubble: {
    maxWidth: '84%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  agentMessage: {
    width: '100%',
    paddingHorizontal: 4,
    paddingVertical: 5,
  },
  messageText: { fontSize: 16, lineHeight: 23 },
  timelineCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 7 },
  activityRail: { borderLeftWidth: 2, gap: 12, paddingLeft: 12 },
  step: { gap: 4 },
  stepLabel: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
  disclosure: { gap: 4 },
  disclosureHeader: {
    minHeight: 44,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 6,
    paddingVertical: 7,
  },
  disclosureChevron: { width: 14, fontSize: 18, lineHeight: 20, textAlign: 'center' },
  disclosureIcon: { width: 15, fontSize: 16, lineHeight: 18, textAlign: 'center' },
  disclosureTitle: { flexShrink: 0, fontSize: 14, lineHeight: 19 },
  disclosurePreview: { minWidth: 0, flex: 1, fontSize: 13, lineHeight: 18 },
  disclosureBody: { marginLeft: 42, paddingBottom: 6 },
  activityDisclosure: { gap: 4 },
  activityDisclosureCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  activityDisclosureHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 6,
  },
  activityDisclosureChevron: { width: 14, fontSize: 18, lineHeight: 20, textAlign: 'center' },
  activityStatusDot: { width: 6, height: 6, borderRadius: 999 },
  activityDisclosureTitle: { minWidth: 0, flexShrink: 1, fontSize: 13, fontWeight: '600' },
  activityDisclosurePreview: { minWidth: 0, flex: 1, fontSize: 13, lineHeight: 18 },
  activityDisclosureStatus: { flexShrink: 0, fontSize: 11, fontWeight: '600', lineHeight: 15 },
  activityDisclosureBody: { marginLeft: 27, paddingBottom: 7, paddingRight: 6 },
  notice: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  noticeIcon: { width: 16, fontSize: 17, fontWeight: '800', lineHeight: 20, textAlign: 'center' },
  noticeContent: { minWidth: 0, flex: 1, gap: 7 },
  noticeDetails: { gap: 6 },
  noticeAction: { fontSize: 12, fontWeight: '700', lineHeight: 17 },
  noticeLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 2 },
  sessionStatus: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sessionStatusRule: { height: StyleSheet.hairlineWidth, flex: 1 },
  sessionStatusLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sessionStatusDot: { width: 5, height: 5, borderRadius: 999 },
  sessionStatusText: { fontSize: 11, lineHeight: 15 },
  turnGroup: { gap: 8 },
  turnSummary: {
    minHeight: 48,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
  },
  turnSummaryText: { flex: 1, fontSize: 13, fontWeight: '600' },
  turnChevron: { width: 13, fontSize: 19, fontWeight: '500', textAlign: 'center' },
  turnOutcome: { width: 14, fontSize: 13, fontWeight: '800', textAlign: 'center' },
  turnDuration: { fontSize: 12, fontVariant: ['tabular-nums'] },
  turnRail: { borderLeftWidth: 2, gap: 12, marginLeft: 8, paddingLeft: 12 },
  cardTitle: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  secondaryText: { fontSize: 14, lineHeight: 20 },
  helpText: { fontSize: 12, lineHeight: 17 },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 12,
    lineHeight: 17,
  },
  approvalOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  approvalSurface: {
    width: '100%',
    maxWidth: 760,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    gap: 10,
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
  },
  approvalItem: { gap: 8 },
  sessionSurfaces: { maxHeight: 300 },
  sessionSurfacesContent: { paddingVertical: 4 },
  humanInputWorkspaceCollapsed: { flexShrink: 0 },
  humanInputWorkspaceExpanded: { flex: 1, minHeight: 0 },
  humanInputDisclosure: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  humanInputDisclosureTitle: { flexShrink: 0, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  humanInputWorkspaceScroll: { flex: 1, minHeight: 0 },
  humanInputWorkspaceBody: { gap: 14, paddingHorizontal: 12, paddingBottom: 16 },
  actionSurfaces: { gap: 14, paddingHorizontal: 12, paddingVertical: 8 },
  actionGroup: { gap: 8 },
  actionTitle: { fontSize: 15, fontWeight: '700' },
  actionCard: { borderRadius: 14, borderWidth: 1, padding: 12, gap: 10 },
  queueSurface: {
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  queueDisclosure: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  queueChevron: { width: 12, fontSize: 18, lineHeight: 20, textAlign: 'center' },
  queueTitle: { flexShrink: 0, fontSize: 13, fontWeight: '600' },
  queuePreview: { minWidth: 0, flex: 1, fontSize: 13 },
  queueRow: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 9 },
  queuePrompt: { fontSize: 14, lineHeight: 19 },
  queueActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  buttonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  buttonWrap: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  button: {
    minHeight: 48,
    minWidth: 48,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonText: { fontSize: 13, fontWeight: '700' },
  compactButton: {
    minHeight: 36,
    minWidth: 0,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  compactButtonText: { fontSize: 12 },
  question: { gap: 8 },
  questionInput: {
    minHeight: 48,
    maxHeight: 144,
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  optionList: { gap: 7 },
  option: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 11,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  optionLabel: { fontSize: 14, fontWeight: '600' },
  otherOptionToggle: { minHeight: 48, justifyContent: 'center' },
  otherInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 9,
    marginTop: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  attachmentStrip: { gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
  attachmentChip: {
    width: 180,
    minHeight: 64,
    borderWidth: 1,
    borderRadius: 12,
    padding: 9,
    gap: 4,
  },
  attachmentName: { fontSize: 13, fontWeight: '600' },
  composerDock: { paddingHorizontal: 12, paddingTop: 5, paddingBottom: 8, gap: 5 },
  composerContainer: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    borderRadius: 28,
    borderWidth: 1,
    padding: 5,
    gap: 4,
  },
  composerRow: { minHeight: 40, flexDirection: 'row', alignItems: 'flex-end' },
  composerStack: { gap: 8 },
  composerInput: {
    minWidth: 0,
    minHeight: 40,
    maxHeight: 120,
    flex: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  composerToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  draftConflict: { borderRadius: 10, padding: 8, gap: 6 },
})
