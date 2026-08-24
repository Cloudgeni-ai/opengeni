import {
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING,
  type PersonalResourceAttachmentIntent,
  type SendMessageInput,
  type Session,
  type Workspace,
} from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuthSession } from "@/types";
import type { ManagedSelfContext } from "./managed-self-context";
import {
  buildPersonalResourceAttachmentIntent,
  isPersonalAttachmentConflict,
  loadPersonalResourceCatalog,
  personalSelection,
  resolvePersonalResourceOwnerScope,
  type FixedPersonalResources,
  type PersonalAttachmentMode,
  type PersonalResourceCatalog,
} from "./personal-resource-attachments";

type PersonalResourceAttachmentAttempt = {
  personalResourceAttachment?: PersonalResourceAttachmentIntent | undefined;
};

export type PersonalResourceAttachmentController = Readonly<{
  eligible: boolean;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  notice: string | null;
  sourceLost: boolean;
  truncated: boolean;
  catalog: PersonalResourceCatalog | null;
  selected: ReturnType<typeof personalSelection>;
  mode: PersonalAttachmentMode | null;
  acknowledged: boolean;
  visibility: "private" | "workspace";
  warning: string;
  requiresDecision: boolean;
  intent: PersonalResourceAttachmentIntent | undefined;
  setMode: (mode: PersonalAttachmentMode | null) => void;
  setAcknowledged: (acknowledged: boolean) => void;
  refresh: () => Promise<void>;
  onAccepted: (
    input: SendMessageInput | { personalResourceAttachment?: PersonalResourceAttachmentIntent },
  ) => void;
  onDeliveryError: (
    error: Error,
    input: PersonalResourceAttachmentAttempt,
    delivery: "send" | "steer" | "create",
  ) => void;
}>;

export function usePersonalResourceAttachment(input: {
  client: OpenGeniCoreClient;
  authMode: string;
  authSession: AuthSession | null;
  accessSubjectId: string;
  managedSelfContext: ManagedSelfContext | null;
  workspace: Pick<Workspace, "id" | "accountId"> | null;
  session?: Pick<Session, "id" | "tenancy"> | null;
  fixed: FixedPersonalResources;
  personalWorkspaceTarget: boolean;
  createVisibility?: "private" | "workspace";
  enabled?: boolean | undefined;
  onReloadSession?: (() => Promise<void>) | undefined;
}): PersonalResourceAttachmentController {
  const onReloadSession = input.onReloadSession;
  const hasFixedResources =
    input.fixed.variableSetId !== null ||
    input.fixed.rigId !== null ||
    input.fixed.connectedMachine !== null;
  const resolvedScope =
    input.enabled === false
      ? null
      : resolvePersonalResourceOwnerScope({
          authMode: input.authMode,
          authSession: input.authSession,
          accessSubjectId: input.accessSubjectId,
          managedSelfContext: input.managedSelfContext,
          workspace: input.workspace,
          session: input.session,
        });
  const resolvedIdentityKey = resolvedScope?.identityKey;
  const resolvedSubjectId = resolvedScope?.subjectId;
  const resolvedOrganizationId = resolvedScope?.organizationId;
  const resolvedTargetWorkspaceId = resolvedScope?.targetWorkspaceId;
  const resolvedPersonalWorkspaceId = resolvedScope?.personalWorkspaceId;
  // Provider refreshes may replace equivalent projection objects. Preserve the
  // catalog and the user's decision until one exact authority identity changes.
  const scope = useMemo(
    () =>
      resolvedIdentityKey &&
      resolvedSubjectId &&
      resolvedOrganizationId &&
      resolvedTargetWorkspaceId &&
      resolvedPersonalWorkspaceId
        ? {
            identityKey: resolvedIdentityKey,
            subjectId: resolvedSubjectId,
            organizationId: resolvedOrganizationId,
            targetWorkspaceId: resolvedTargetWorkspaceId,
            personalWorkspaceId: resolvedPersonalWorkspaceId,
          }
        : null,
    [
      resolvedIdentityKey,
      resolvedOrganizationId,
      resolvedPersonalWorkspaceId,
      resolvedSubjectId,
      resolvedTargetWorkspaceId,
    ],
  );
  const scopeKey = scope?.identityKey ?? "ineligible";
  const [catalog, setCatalog] = useState<PersonalResourceCatalog | null>(null);
  const [loading, setLoading] = useState(scope !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceLost, setSourceLost] = useState(false);
  const [mode, setModeState] = useState<PersonalAttachmentMode | null>(null);
  const [acknowledged, setAcknowledgedState] = useState(false);
  const loadGeneration = useRef(0);
  const acceptedScopeKey = useRef(scopeKey);

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      const generation = ++loadGeneration.current;
      if (!scope) {
        setCatalog(null);
        setLoading(false);
        setRefreshing(false);
        setError(null);
        return;
      }
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const next = await loadPersonalResourceCatalog(input.client, scope);
        if (generation !== loadGeneration.current || acceptedScopeKey.current !== scopeKey) return;
        setCatalog(next);
        setError(null);
      } catch (cause) {
        if (generation !== loadGeneration.current || acceptedScopeKey.current !== scopeKey) return;
        setCatalog(null);
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (generation === loadGeneration.current && acceptedScopeKey.current === scopeKey) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [input.client, scope, scopeKey],
  );

  useEffect(() => {
    acceptedScopeKey.current = scopeKey;
    loadGeneration.current += 1;
    setCatalog(null);
    setModeState(null);
    setAcknowledgedState(false);
    setNotice(null);
    setSourceLost(false);
    setError(null);
    setLoading(scope !== null);
    setRefreshing(false);
    void load(false);
  }, [load, scope, scopeKey]);

  // Eligibility is a synchronous fence. Do not wait for the transition effect
  // to clear prior owner state before hiding it from a connected-machine send.
  const selected = personalSelection(scope ? catalog : null, input.fixed);
  const fixedIdentity = `${input.fixed.variableSetId ?? ""}:${input.fixed.rigId ?? ""}:${input.fixed.connectedMachine?.enrollmentId ?? ""}`;
  const selectedIdentity = `${fixedIdentity}:${selected.resourceCount}`;
  const priorSelectionIdentity = useRef(selectedIdentity);
  const priorFixedIdentity = useRef(fixedIdentity);
  const priorSelectionScopeKey = useRef(scopeKey);
  const priorSelectedCount = useRef(selected.resourceCount);
  useEffect(() => {
    const scopeChanged = priorSelectionScopeKey.current !== scopeKey;
    if (!scopeChanged && priorSelectionIdentity.current === selectedIdentity) return;
    const fixedChanged = priorFixedIdentity.current !== fixedIdentity;
    const lost =
      !scopeChanged &&
      !fixedChanged &&
      priorSelectedCount.current > 0 &&
      selected.resourceCount === 0;
    priorSelectionIdentity.current = selectedIdentity;
    priorFixedIdentity.current = fixedIdentity;
    priorSelectionScopeKey.current = scopeKey;
    priorSelectedCount.current = selected.resourceCount;
    setModeState(null);
    setAcknowledgedState(false);
    setSourceLost(lost);
    setNotice(
      lost
        ? "Access to the selected personal resource changed. Choose an available resource before submitting."
        : null,
    );
  }, [fixedIdentity, scopeKey, selected.resourceCount, selectedIdentity]);

  const visibility = input.session?.tenancy
    ? input.session.tenancy.visibility === "workspace"
      ? "workspace"
      : "private"
    : input.personalWorkspaceTarget
      ? "private"
      : (input.createVisibility ?? "workspace");
  const expectedAuthorityEpoch = input.session?.tenancy?.authorityEpoch;
  const fixedResourceCount =
    Number(input.fixed.variableSetId !== null) +
    Number(input.fixed.rigId !== null) +
    Number(input.fixed.connectedMachine !== null);
  const closureError = selected.closureUnverified
    ? new Error(
        "The selected personal-resource authority closure could not be verified. Retry or choose a non-personal resource.",
      )
    : null;
  const effectiveError = error ?? closureError;
  const intent = scope
    ? buildPersonalResourceAttachmentIntent({
        mode,
        visibility,
        acknowledged,
        expectedAuthorityEpoch,
        resourceCount: selected.closureUnverified ? 0 : selected.resourceCount,
      })
    : undefined;
  const requiresDecision =
    scope !== null &&
    (sourceLost ||
      (fixedResourceCount > 0 && (loading || refreshing || effectiveError !== null)) ||
      (selected.resourceCount > 0 &&
        (mode === null || (visibility === "workspace" && !acknowledged))));

  const setMode = useCallback((next: PersonalAttachmentMode | null) => {
    setModeState(next);
    setSourceLost(false);
    setNotice(null);
    if (next === null) setAcknowledgedState(false);
  }, []);
  const setAcknowledged = useCallback((next: boolean) => {
    setAcknowledgedState(next);
    setNotice(null);
  }, []);
  const refresh = useCallback(async () => await load(true), [load]);
  const onAccepted = useCallback(
    (acceptedInput: {
      personalResourceAttachment?: PersonalResourceAttachmentIntent | undefined;
    }) => {
      if (!acceptedInput.personalResourceAttachment) return;
      setNotice("Personal-resource use was accepted for this work.");
      if (acceptedInput.personalResourceAttachment.mode === "once") {
        setModeState(null);
        setAcknowledgedState(false);
      }
      void load(true);
    },
    [load],
  );
  const onDeliveryError = useCallback(
    (deliveryError: Error, attemptedInput: PersonalResourceAttachmentAttempt) => {
      if (!isPersonalAttachmentConflict(deliveryError, attemptedInput)) return;
      setModeState(null);
      setAcknowledgedState(false);
      setNotice(
        "Session authority changed. Personal resources were reloaded; review and confirm them again before retrying.",
      );
      void Promise.all([load(true), onReloadSession?.() ?? Promise.resolve()]);
    },
    [load, onReloadSession],
  );

  return {
    eligible: scope !== null,
    // Catalog discovery populates the resource pickers in the background. It
    // becomes submission UI only after the user has actually selected a fixed
    // personal resource; an unavailable optional catalog must not turn an
    // ordinary new-session composer into an error state.
    loading: hasFixedResources && loading,
    refreshing: hasFixedResources && refreshing,
    error: hasFixedResources ? effectiveError : null,
    notice,
    sourceLost,
    truncated: hasFixedResources && (catalog?.truncated ?? false),
    catalog,
    selected,
    mode,
    acknowledged,
    visibility,
    warning: PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING,
    requiresDecision,
    intent,
    setMode,
    setAcknowledged,
    refresh,
    onAccepted,
    onDeliveryError,
  };
}
