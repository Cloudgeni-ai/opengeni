import { type OpenGeniText } from "@opengeni/react/messages";
export interface OpenGeniNativeTheme {
  dark: boolean;
  colors: {
    background: string;
    surface: string;
    elevated: string;
    border: string;
    text: string;
    secondaryText: string;
    mutedText: string;
    accent: string;
    accentForeground: string;
    userBubble: string;
    userBubbleText: string;
    danger: string;
    dangerSurface: string;
    warning: string;
    warningSurface: string;
    success: string;
  };
}

export interface OpenGeniNativeLabels {
  knowledgeOutcome: Record<"published" | "pending" | "rejected" | "archived" | "failed", string>;
  emptyTitle: string;
  emptyDescription: string;
  loadEarlier: string;
  loadingEarlier: string;
  reconnecting: string;
  connecting: string;
  offlinePaused: string;
  error: string;
  retry: string;
  dismiss: string;
  queueTitle: string;
  queueEmpty: string;
  edit: string;
  runNext: string;
  remove: string;
  moveEarlier: string;
  moveLater: string;
  approvalsTitle: string;
  approve: string;
  deny: string;
  questionsTitle: string;
  humanInputAsked: string;
  humanInputOutcome: {
    answered: string;
    /** An agent answered (for example the parent of a sub-session); defaults to `answered`. */
    agentAnswered?: string;
    /** An agent skipped the question; defaults to `skipped`. */
    agentSkipped?: string;
    skipped: string;
    expired: string;
    cancelled: string;
  };
  submitAnswers: string;
  skip: string;
  other: string;
  required: string;
  attachDocument: string;
  attachImage: string;
  preparingAttachment: string;
  uploading: string;
  uploadFailed: string;
  attachmentError: string;
  removeAttachment: string;
  retryUpload: string;
  restoredAttachment: string;
  composerPlaceholder: string;
  send: string;
  steer: string;
  /** Queue a message behind the running work (the alternate action when Send steers). */
  queue: string;
  pause: string;
  resume: string;
  savingDraft: string;
  draftConflict: string;
  keepMine: string;
  useRemote: string;
  thinking: string;
  thought: string;
  reasoning: string;
  tool: string;
  worker: string;
  user: string;
  assistant: string;
  sandbox: string;
  goal: string;
  goalAction: {
    set: string;
    updated: string;
    completed: string;
    paused: string;
    resumed: string;
    cleared: string;
    held: string;
    continuation: string;
  };
  contextUpdated: string;
  contextCompactionPhase: {
    started: string;
    compacted: string;
    skipped: string;
  };
  machineUpdates: string;
  connectionRequired: string;
  memory: string;
  memoryAction: {
    saved: string;
    corrected: string;
    updated: string;
    archived: string;
  };
  fleetDecision: string;
  fleetOutcome: {
    selected: string;
    waiting: string;
    none: string;
  };
  fleetReason: {
    leaseReused: string;
    pin: string;
    rotation: string;
    active: string;
    allCapped: string;
    none: string;
  };
  turn: string;
  activity: string;
  statusQueued: string;
  statusRunning: string;
  statusComplete: string;
  statusRecovering: string;
  statusWaitingCapacity: string;
  statusIdle: string;
  statusRequiresAction: string;
  /** The runtime could not start the next turn; nothing is asked of the person. */
  statusBlocked: string;
  statusFailed: string;
  statusCancelled: string;
  relativeNow: string;
  relativeSeconds: string;
  relativeMinutes: string;
  relativeHours: string;
  relativeDays: string;
  /** A collection preview ("3 items"). */
  itemCount: (count: number) => string;
  /** Where a secret answer was saved; its value never reaches the timeline. */
  secretSaved: (vaultName: string, itemName: string) => string;
}

export const DEFAULT_OPENGENI_NATIVE_LABELS = (t: OpenGeniText) =>
  ({
    knowledgeOutcome: {
      published: t("native.presentation.knowledgePublished"),
      pending: t("native.presentation.knowledgeAwaitingReview"),
      rejected: t("native.presentation.knowledgeRejected"),
      archived: t("native.presentation.knowledgeArchived"),
      failed: t("native.presentation.knowledgeCouldNotBeSaved"),
    },
    emptyTitle: t("native.presentation.startAConversation"),
    emptyDescription: t("native.presentation.askTheAgentToHelp"),
    loadEarlier: t("native.presentation.loadEarlierActivity"),
    loadingEarlier: t("native.presentation.loadingEarlierActivity"),
    reconnecting: t("native.presentation.reconnecting"),
    connecting: t("native.presentation.connecting"),
    offlinePaused: t("native.presentation.liveUpdatesPauseWhileThe"),
    error: t("native.presentation.somethingWentWrongTryAgain"),
    retry: t("native.presentation.retry"),
    dismiss: t("native.presentation.dismiss"),
    queueTitle: t("native.presentation.queuedPrompts"),
    queueEmpty: t("native.presentation.noQueuedPrompts"),
    edit: t("native.presentation.edit"),
    runNext: t("native.presentation.runNext"),
    remove: t("native.presentation.remove"),
    moveEarlier: t("native.presentation.moveEarlier"),
    moveLater: t("native.presentation.moveLater"),
    approvalsTitle: t("native.presentation.approvalRequired"),
    approve: t("native.presentation.approve"),
    deny: t("native.presentation.deny"),
    questionsTitle: t("native.presentation.yourInputIsNeeded"),
    humanInputAsked: t("native.presentation.agentAsked"),
    humanInputOutcome: {
      answered: t("native.presentation.youAnswered"),
      agentAnswered: t("native.presentation.agentAnswered"),
      agentSkipped: t("native.presentation.agentSkipped"),
      skipped: t("native.presentation.skipped"),
      expired: t("native.presentation.expired"),
      cancelled: t("native.presentation.cancelled"),
    },
    submitAnswers: t("native.presentation.submitAnswers"),
    skip: t("native.presentation.skip"),
    other: t("native.presentation.other"),
    required: t("native.presentation.required"),
    attachDocument: t("native.presentation.attachDocument"),
    attachImage: t("native.presentation.attachImage"),
    preparingAttachment: t("native.presentation.preparing"),
    uploading: t("native.presentation.uploading"),
    uploadFailed: t("native.presentation.uploadFailed"),
    attachmentError: t("native.presentation.couldNotOpenTheFile"),
    removeAttachment: t("native.presentation.removeAttachment"),
    retryUpload: t("native.presentation.retryUpload"),
    restoredAttachment: t("native.presentation.attachedFile"),
    composerPlaceholder: t("native.presentation.messageTheAgent"),
    send: t("native.presentation.send"),
    steer: t("native.presentation.steer"),
    queue: t("native.presentation.queue"),
    pause: t("native.presentation.pause"),
    resume: t("native.presentation.resume"),
    savingDraft: t("native.presentation.savingDraft"),
    draftConflict: t("native.presentation.thisDraftChangedElsewhere"),
    keepMine: t("native.presentation.keepMine"),
    useRemote: t("native.presentation.useSavedDraft"),
    thinking: t("native.presentation.thinking"),
    thought: t("native.presentation.thought"),
    reasoning: t("native.presentation.reasoning"),
    tool: t("native.presentation.tool"),
    worker: t("native.presentation.worker"),
    user: t("native.presentation.you"),
    assistant: t("native.presentation.assistant"),
    sandbox: t("native.presentation.sandbox"),
    goal: t("native.presentation.goal"),
    goalAction: {
      set: t("native.presentation.goalSet"),
      updated: t("native.presentation.goalUpdated"),
      completed: t("native.presentation.goalCompleted"),
      paused: t("native.presentation.goalPaused"),
      resumed: t("native.presentation.goalResumed"),
      cleared: t("native.presentation.goalCleared"),
      held: t("native.presentation.goalHeld"),
      continuation: t("native.presentation.continuingTowardTheGoal"),
    },
    contextUpdated: t("native.presentation.contextUpdated"),
    contextCompactionPhase: {
      started: t("native.presentation.compactingConversationHistory"),
      compacted: t("native.presentation.conversationHistoryCompacted"),
      skipped: t("native.presentation.conversationHistoryCompactionSkipped"),
    },
    // Templates: the view model fills their placeholders.
    machineUpdates: t("native.presentation.machineUpdates", { value: "{value}" }),
    connectionRequired: t("native.presentation.connectionRequired", { provider: "{provider}" }),
    memory: t("native.presentation.memory"),
    memoryAction: {
      saved: t("native.presentation.savedToMemory"),
      corrected: t("native.presentation.updatedMemory"),
      updated: t("native.presentation.updatedMemoryInPlace"),
      archived: t("native.presentation.archivedMemory"),
    },
    fleetDecision: t("native.presentation.fleetDecision"),
    fleetOutcome: {
      selected: t("native.presentation.fleetSelected", { candidate: "{candidate}" }),
      waiting: t("native.presentation.waitingForCapacity"),
      none: t("native.presentation.noCandidateSelected"),
    },
    fleetReason: {
      leaseReused: t("native.presentation.reusedTheFencedLease"),
      pin: t("native.presentation.keptTheSessionPin"),
      rotation: t("native.presentation.rotatedForCapacity"),
      active: t("native.presentation.usedTheActiveSubscription"),
      allCapped: t("native.presentation.allObservedSubscriptionsWereCapped"),
      none: t("native.presentation.noProductionCandidateWasSelected"),
    },
    turn: t("native.presentation.turn"),
    activity: t("native.presentation.activity"),
    statusQueued: t("native.presentation.queued"),
    statusRunning: t("native.presentation.running"),
    statusComplete: t("native.presentation.complete"),
    statusRecovering: t("native.presentation.recovering"),
    statusWaitingCapacity: t("native.presentation.limitReached"),
    statusIdle: t("native.presentation.idle"),
    statusRequiresAction: t("native.presentation.waitingOnYou"),
    statusBlocked: t("native.presentation.stuck"),
    statusFailed: t("native.presentation.failed"),
    statusCancelled: t("native.presentation.cancelled"),
    relativeNow: t("native.presentation.relativeNow"),
    relativeSeconds: t("native.presentation.relativeSeconds", { value: "{value}" }),
    relativeMinutes: t("native.presentation.relativeMinutes", { value: "{value}" }),
    relativeHours: t("native.presentation.relativeHours", { value: "{value}" }),
    relativeDays: t("native.presentation.relativeDays", { value: "{value}" }),
    itemCount: (count) => t("counts.items", { count }),
    secretSaved: (vaultName, itemName) =>
      t("native.timeline.secretFieldModel.savedToVaultnameItemname", { vaultName, itemName }),
  }) satisfies OpenGeniNativeLabels;

export const DEFAULT_OPENGENI_NATIVE_THEME: OpenGeniNativeTheme = {
  dark: false,
  colors: {
    background: "#f7f7f5",
    surface: "#ffffff",
    elevated: "#f0f0ed",
    border: "#dfdfda",
    text: "#1b1b19",
    secondaryText: "#5c5c57",
    mutedText: "#83837b",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    userBubble: "#1f2937",
    userBubbleText: "#ffffff",
    danger: "#b42318",
    dangerSurface: "#fef3f2",
    warning: "#b54708",
    warningSurface: "#fffaeb",
    success: "#067647",
  },
};
