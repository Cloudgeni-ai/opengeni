import { resolveModelProvider, withCodexCatalogProvider, type Settings } from "@opengeni/config";
import { SUBSCRIPTION_MODEL_CATALOG_TTL_MS, type Database } from "@opengeni/db";
import { refreshCoreCodexModelEntitlements } from "../codex-model-availability";
import { resolveCatalogSettings } from "../model-catalog";

const preparations = new WeakMap<Database, Map<string, { pending: boolean; until: number }>>();

/**
 * A committed, debounced draft save is a hint, never turn admission. Prepare
 * only reusable shared catalog facts. No workflow, lease, model, MCP or
 * sandbox is started, and Send still makes every authority decision itself.
 * React and React Native durable composers already share this save path.
 */
export function prepareDraftModel(
  deps: { db: Database; settings: Settings },
  context: { accountId: string; workspaceId: string; subjectId: string },
  draft: { text: string; resources: readonly unknown[]; model: string },
  refresh: typeof refreshCoreCodexModelEntitlements = refreshCoreCodexModelEntitlements,
): void {
  if (!draft.text.trim() && draft.resources.length === 0) return;
  if (!deps.settings.codexSubscriptionEnabled) return;
  const modelId = draft.model;
  const scope = {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    subjectId: context.subjectId,
  };
  let pending = preparations.get(deps.db);
  if (!pending) preparations.set(deps.db, (pending = new Map()));
  // Different drafts/tabs share facts, not authority or draft text. Keep only
  // the existing catalog freshness window, with no idle polling or renewal.
  const key = JSON.stringify([context.accountId, context.workspaceId, context.subjectId, modelId]);
  const now = Date.now();
  const existing = pending.get(key);
  if (existing && (existing.pending || existing.until > now)) return;
  for (const [id, entry] of pending) {
    if (!entry.pending && entry.until <= now) pending.delete(id);
  }
  const entry = { pending: true, until: now + SUBSCRIPTION_MODEL_CATALOG_TTL_MS };
  pending.set(key, entry);
  void Promise.resolve()
    .then(async () => {
      // Existing-session command callers may carry environment settings rather
      // than the deployment's current catalog. Resolve unknown models here,
      // off the save path; the normal Send still resolves its own live policy.
      let settings = deps.settings;
      let model = resolveModelProvider(withCodexCatalogProvider(settings), modelId)?.model;
      if (!model) {
        settings = (await resolveCatalogSettings(deps.db, settings)).settings;
        model = resolveModelProvider(withCodexCatalogProvider(settings), modelId)?.model;
      }
      if (
        model?.credentialSource.kind === "connected_subscription" &&
        model.credentialSource.provider === "codex"
      )
        entry.until = await refresh(deps.db, settings, scope, undefined, {
          refreshCredentials: false,
        });
    })
    .catch(() => {
      entry.until = Date.now() + 5_000;
    })
    .finally(() => {
      entry.pending = false;
    });
}
