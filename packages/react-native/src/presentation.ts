export interface OpenGeniNativeTheme {
  dark: boolean
  colors: {
    background: string
    surface: string
    elevated: string
    border: string
    text: string
    secondaryText: string
    mutedText: string
    accent: string
    accentForeground: string
    userBubble: string
    userBubbleText: string
    danger: string
    dangerSurface: string
    warning: string
    warningSurface: string
    success: string
  }
}

export interface OpenGeniNativeLabels {
  knowledgeOutcome?: Record<'published' | 'pending' | 'rejected' | 'archived' | 'failed', string>
  emptyTitle: string
  emptyDescription: string
  loadEarlier: string
  loadingEarlier: string
  reconnecting: string
  connecting: string
  offlinePaused: string
  error: string
  retry: string
  dismiss: string
  queueTitle: string
  queueEmpty: string
  edit: string
  runNext: string
  remove: string
  moveEarlier: string
  moveLater: string
  approvalsTitle: string
  approve: string
  deny: string
  questionsTitle: string
  humanInputAsked: string
  humanInputOutcome: {
    answered: string
    skipped: string
    expired: string
    cancelled: string
  }
  submitAnswers: string
  skip: string
  other: string
  required: string
  attachDocument: string
  attachImage: string
  preparingAttachment: string
  uploading: string
  uploadFailed: string
  attachmentError: string
  removeAttachment: string
  retryUpload: string
  restoredAttachment: string
  composerPlaceholder: string
  send: string
  steer: string
  pause: string
  resume: string
  savingDraft: string
  draftConflict: string
  keepMine: string
  useRemote: string
  thinking: string
  thought: string
  reasoning: string
  tool: string
  worker: string
  user: string
  assistant: string
  sandbox: string
  goal: string
  goalAction: {
    set: string
    updated: string
    completed: string
    paused: string
    resumed: string
    cleared: string
    held: string
    continuation: string
  }
  contextUpdated: string
  contextCompactionPhase: {
    started: string
    compacted: string
    skipped: string
  }
  machineUpdates: string
  connectionRequired: string
  memory: string
  memoryAction: {
    saved: string
    corrected: string
    updated: string
    archived: string
  }
  fleetDecision: string
  fleetOutcome: {
    selected: string
    waiting: string
    none: string
  }
  fleetReason: {
    leaseReused: string
    pin: string
    rotation: string
    active: string
    allCapped: string
    none: string
  }
  turn: string
  activity: string
  statusQueued: string
  statusRunning: string
  statusComplete: string
  statusRecovering: string
  statusWaitingCapacity: string
  statusIdle: string
  statusRequiresAction: string
  statusFailed: string
  statusCancelled: string
  relativeNow: string
  relativeSeconds: string
  relativeMinutes: string
  relativeHours: string
  relativeDays: string
}

export const DEFAULT_OPENGENI_NATIVE_LABELS = {
  knowledgeOutcome: {
    published: 'Knowledge published',
    pending: 'Knowledge awaiting review',
    rejected: 'Knowledge rejected',
    archived: 'Knowledge archived',
    failed: 'Knowledge could not be saved',
  },
  emptyTitle: 'Start a conversation',
  emptyDescription: 'Ask the agent to help with work in this session.',
  loadEarlier: 'Load earlier activity',
  loadingEarlier: 'Loading earlier activity…',
  reconnecting: 'Reconnecting…',
  connecting: 'Connecting…',
  offlinePaused: 'Live updates pause while the app is in the background.',
  error: 'Something went wrong. Try again.',
  retry: 'Retry',
  dismiss: 'Dismiss',
  queueTitle: 'Queued prompts',
  queueEmpty: 'No queued prompts',
  edit: 'Edit',
  runNext: 'Run next',
  remove: 'Remove',
  moveEarlier: 'Move earlier',
  moveLater: 'Move later',
  approvalsTitle: 'Approval required',
  approve: 'Approve',
  deny: 'Deny',
  questionsTitle: 'Your input is needed',
  humanInputAsked: 'Agent asked',
  humanInputOutcome: {
    answered: 'You answered',
    skipped: 'Skipped',
    expired: 'Expired',
    cancelled: 'Cancelled',
  },
  submitAnswers: 'Submit answers',
  skip: 'Skip',
  other: 'Other',
  required: 'Required',
  attachDocument: 'Attach document',
  attachImage: 'Attach image',
  preparingAttachment: 'Preparing…',
  uploading: 'Uploading…',
  uploadFailed: 'Upload failed',
  attachmentError: 'Could not open the file picker.',
  removeAttachment: 'Remove attachment',
  retryUpload: 'Retry upload',
  restoredAttachment: 'Attached file',
  composerPlaceholder: 'Message the agent…',
  send: 'Send',
  steer: 'Steer',
  pause: 'Pause',
  resume: 'Resume',
  savingDraft: 'Saving draft…',
  draftConflict: 'This draft changed elsewhere.',
  keepMine: 'Keep mine',
  useRemote: 'Use saved draft',
  thinking: 'Thinking',
  thought: 'Thought',
  reasoning: 'Reasoning',
  tool: 'Tool',
  worker: 'Worker',
  user: 'You',
  assistant: 'Assistant',
  sandbox: 'Sandbox',
  goal: 'Goal',
  goalAction: {
    set: 'Goal set',
    updated: 'Goal updated',
    completed: 'Goal completed',
    paused: 'Goal paused',
    resumed: 'Goal resumed',
    cleared: 'Goal cleared',
    held: 'Goal held',
    continuation: 'Continuing toward the goal',
  },
  contextUpdated: 'Context updated',
  contextCompactionPhase: {
    started: 'Compacting conversation history',
    compacted: 'Conversation history compacted',
    skipped: 'Conversation history compaction skipped',
  },
  machineUpdates: 'Machine updates: {value}',
  connectionRequired: 'Connection required for {provider}',
  memory: 'Memory',
  memoryAction: {
    saved: 'Saved to memory',
    corrected: 'Updated memory',
    updated: 'Updated memory in place',
    archived: 'Archived memory',
  },
  fleetDecision: 'Fleet decision',
  fleetOutcome: {
    selected: 'Selected {candidate}',
    waiting: 'Waiting for capacity',
    none: 'No candidate selected',
  },
  fleetReason: {
    leaseReused: 'Reused the fenced lease',
    pin: 'Kept the session pin',
    rotation: 'Rotated for capacity',
    active: 'Used the active subscription',
    allCapped: 'All observed subscriptions were capped',
    none: 'No production candidate was selected',
  },
  turn: 'Turn',
  activity: 'Activity',
  statusQueued: 'Queued',
  statusRunning: 'Running',
  statusComplete: 'Complete',
  statusRecovering: 'Recovering',
  statusWaitingCapacity: 'Waiting for capacity',
  statusIdle: 'Idle',
  statusRequiresAction: 'Waiting on you',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',
  relativeNow: 'now',
  relativeSeconds: '{value}s',
  relativeMinutes: '{value}m',
  relativeHours: '{value}h',
  relativeDays: '{value}d',
} satisfies OpenGeniNativeLabels

export const DEFAULT_OPENGENI_NATIVE_THEME: OpenGeniNativeTheme = {
  dark: false,
  colors: {
    background: '#f7f7f5',
    surface: '#ffffff',
    elevated: '#f0f0ed',
    border: '#dfdfda',
    text: '#1b1b19',
    secondaryText: '#5c5c57',
    mutedText: '#83837b',
    accent: '#2563eb',
    accentForeground: '#ffffff',
    userBubble: '#1f2937',
    userBubbleText: '#ffffff',
    danger: '#b42318',
    dangerSurface: '#fef3f2',
    warning: '#b54708',
    warningSurface: '#fffaeb',
    success: '#067647',
  },
}
