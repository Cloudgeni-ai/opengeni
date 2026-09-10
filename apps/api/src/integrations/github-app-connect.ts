import { createHash } from "node:crypto";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { ConnectAdvance, ConnectAttempt } from "@opengeni/contracts/connect";
import {
  bindAuthorizedGitHubInstallationRepositories,
  claimConnectOperation,
  finishConnectOperation,
  getConnectAttempt,
  type ConnectActorScope,
  type ConnectOperationAuthorization,
} from "@opengeni/db";
import {
  authorizeGitHubInstallationBinding,
  createSignedState,
  discoverGitHubInstallationBindingCandidates,
  githubAppMissingSettings,
  githubOAuthAuthorizeUrl,
  readSignedState,
  prReviewGitHubAppMissingSettings,
  settingsForPrReviewGitHubApp,
} from "@opengeni/github";
import { commitGitHubLensConnect, requireGitHubLensConnect } from "./github-lens-connect";
import type { ApiRouteDeps, PreparedConnectOperation } from "@opengeni/core";
import { requireConnectOwnerAuthority } from "./connect-authority";
import { integrationBaseUrl } from "./oauth-client";
import {
  isConsistentGitHubBindingCandidates,
  isConsistentGitHubBindingProof,
} from "./github-installation-proof";

const stateSchema = z.object({
  kind: z.literal("github_app_connect"),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string().min(1),
  personalOwnerVerified: z.boolean(),
  connectAttemptId: z.string().uuid(),
  phase: z.enum(["discover", "install", "bind"]),
  installationId: z.number().int().positive().safe().optional(),
  providerId: z.enum(["github-app", "github-lens"]).default("github-app"),
  nonce: z.string().min(1),
  iat: z.number().int(),
});
type State = z.infer<typeof stateSchema>;
const lifetimeMs = 10 * 60_000;

export function isGitHubAppConnectState(deps: ApiRouteDeps, raw: string | undefined): boolean {
  return !!raw && readSignedState(raw, deps.githubStateSecret)?.kind === "github_app_connect";
}

type GitHubConnectScope = ConnectActorScope & {
  personalOwnerVerified?: boolean;
  providerId?: "github-app" | "github-lens";
};
function callbackAuthority(scope: GitHubConnectScope): ConnectOperationAuthorization {
  return async (tx, _attempt, origin) => {
    const actor = { ...scope, ...(origin ? { externalContinuation: origin } : {}) };
    await requireConnectOwnerAuthority(
      tx,
      actor,
      scope.providerId === "github-lens" ? "workspace:admin" : "github:manage",
      origin,
    );
    if (scope.providerId === "github-lens")
      await requireConnectOwnerAuthority(tx, actor, "secrets:write", origin);
  };
}

export function githubAppConnectNavigation(
  deps: ApiRouteDeps,
  scope: GitHubConnectScope,
  attemptId: string,
  requestUrl: string,
  phase: State["phase"] = "discover",
  installationId?: number,
  providerId: State["providerId"] = "github-app",
) {
  const settings =
    providerId === "github-lens" ? settingsForPrReviewGitHubApp(deps.settings) : deps.settings;
  const missing =
    providerId === "github-lens"
      ? prReviewGitHubAppMissingSettings(deps.settings)
      : githubAppMissingSettings(settings);
  if (missing.length || !settings.githubAppSlug?.trim())
    throw new HTTPException(503, { message: "GitHub App is not configured" });
  const state = createSignedState(deps.githubStateSecret, {
    kind: "github_app_connect",
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: scope.subjectId,
    personalOwnerVerified: scope.personalOwnerVerified === true,
    connectAttemptId: attemptId,
    phase,
    providerId,
    ...(installationId ? { installationId } : {}),
  });
  const url =
    phase === "install"
      ? `https://github.com/apps/${encodeURIComponent(settings.githubAppSlug.trim())}/installations/new?state=${encodeURIComponent(state)}`
      : githubOAuthAuthorizeUrl({
          clientId: settings.githubClientId!.trim(),
          state,
          redirectUri: `${integrationBaseUrl(deps.settings.publicBaseUrl, requestUrl)}${providerId === "github-lens" ? "/v1/pr-review/github" : "/v1/github"}/oauth/callback`,
        });
  return { authorizationUrl: url, expiresAt: new Date(Date.now() + lifetimeMs).toISOString() };
}

export function prepareGitHubAppConnectAction(
  deps: ApiRouteDeps,
  scope: GitHubConnectScope,
  requestUrl: string,
  attempt: ConnectAttempt,
  action: ConnectAdvance,
): PreparedConnectOperation {
  let phase: State["phase"] = "discover";
  let installationId: number | undefined;
  if (action.type === "account") {
    if (
      attempt.nextAction.type !== "select_account" ||
      !attempt.nextAction.accounts.some((account) => account.id === action.accountId)
    )
      throw new HTTPException(409, {
        message: "Choose an installation from the current discovery",
      });
    if (action.accountId === "new") phase = "install";
    else {
      phase = "bind";
      installationId = z.coerce.number().int().positive().safe().parse(action.accountId);
    }
  } else if (action.type !== "retry" || attempt.state !== "connected_but_incomplete") {
    throw new HTTPException(422, {
      message: "Choose an installation or retry after owner approval",
    });
  }
  const navigation = githubAppConnectNavigation(
    deps,
    scope,
    attempt.id,
    requestUrl,
    phase,
    installationId,
    attempt.providerId === "github-lens" ? "github-lens" : "github-app",
  );
  return {
    commit: async (_tx, current) => ({
      ...current,
      error: undefined,
      revision: current.revision + 1,
      state: "requires_user_action",
      nextAction: { type: "authorize", url: navigation.authorizationUrl },
    }),
  };
}

/** No browser login/cookie required: signed attempt + current stored origin,
 * then fresh GitHub owner proof, are the two separate authority boundaries. */
export async function completeGitHubAppConnect(
  deps: ApiRouteDeps,
  input: {
    state?: string | undefined;
    code?: string | undefined;
    installationId?: string | undefined;
    setupAction?: string | undefined;
    error?: string | undefined;
    requestUrl: string;
    expectedProvider?: "github-app" | "github-lens";
  },
): Promise<Response> {
  let destination: string | undefined;
  try {
    const state = stateSchema.parse(readSignedState(input.state ?? "", deps.githubStateSecret));
    if (state.providerId !== (input.expectedProvider ?? "github-app"))
      throw new Error("GitHub callback provider mismatch");
    const age = Date.now() - state.iat * 1000;
    if (age < 0 || age >= lifetimeMs) throw new Error("Expired GitHub connection state");
    const stored = await getConnectAttempt(deps.db, state, state.connectAttemptId);
    if (stored.attempt.providerId !== state.providerId || stored.attempt.ownership !== "workspace")
      throw new Error("GitHub attempt mismatch");
    destination = stored.returnUrl;
    // Reject obsolete browser stages before committing an operation claim.
    // Otherwise a valid older callback could strand the current stage in-flight.
    // Completed callbacks still navigate home without repeating provider work.
    if (
      stored.attempt.nextAction.type !== "authorize" ||
      new URL(stored.attempt.nextAction.url).searchParams.get("state") !== input.state
    )
      throw new Error("Stale GitHub setup stage");
    if (state.providerId === "github-lens") await requireGitHubLensConnect(deps, state.workspaceId);
    const authorize = callbackAuthority(state);
    const operation = {
      attemptId: state.connectAttemptId,
      operationId: `github:${state.nonce}`,
      inputDigest: createHash("sha256").update(input.state!).digest("hex"),
      authorize,
    };
    const claim = await claimConnectOperation(deps.db, state, {
      ...operation,
      expectedRevision: stored.attempt.revision,
    });
    if (claim.status !== "replayed") {
      const provider =
        state.providerId === "github-lens" ? deps.prReviewGithubAppApi : deps.githubAppApi;
      const settings =
        state.providerId === "github-lens"
          ? settingsForPrReviewGitHubApp(deps.settings)
          : deps.settings;
      let prepared: PreparedConnectOperation;
      if (input.error || (state.phase !== "install" && !input.code)) {
        prepared = {
          commit: async (_tx, current) => ({
            ...current,
            revision: current.revision + 1,
            state: input.error === "access_denied" ? "cancelled" : "failed",
            nextAction: { type: "none" },
            error: {
              code: "authorization_not_completed",
              message: "Authorization was not completed. Start a new attempt.",
              retryable: false,
            },
          }),
        };
      } else if (state.phase === "install") {
        if (input.setupAction === "request")
          prepared = {
            commit: async (_tx, current) => ({
              ...current,
              revision: current.revision + 1,
              state: "connected_but_incomplete",
              nextAction: { type: "none" },
              error: {
                code: "owner_approval_pending",
                message:
                  "A GitHub organization owner must approve installation. Retry discovery after approval.",
                retryable: true,
              },
            }),
          };
        else {
          const installationId = z.coerce
            .number()
            .int()
            .positive()
            .safe()
            .parse(input.installationId);
          const navigation = githubAppConnectNavigation(
            deps,
            state,
            state.connectAttemptId,
            input.requestUrl,
            "bind",
            installationId,
            state.providerId,
          );
          prepared = {
            commit: async (_tx, current) => ({
              ...current,
              revision: current.revision + 1,
              state: "requires_user_action",
              nextAction: { type: "authorize", url: navigation.authorizationUrl },
            }),
          };
        }
      } else if (state.phase === "discover") {
        const candidates = provider
          ? await provider.discoverInstallationBindingCandidates?.({ code: input.code! })
          : await discoverGitHubInstallationBindingCandidates(settings, { code: input.code! });
        if (!candidates || !isConsistentGitHubBindingCandidates(candidates))
          throw new Error("Provider cannot prove installation candidates");
        prepared =
          candidates.length > 99
            ? {
                commit: async (_tx, current) => ({
                  ...current,
                  revision: current.revision + 1,
                  state: "failed",
                  nextAction: { type: "none" },
                  error: {
                    code: "installation_selection_limit",
                    message:
                      "This account exceeds the 99-installation Connect chooser limit; no installations were omitted or bound.",
                    retryable: false,
                  },
                }),
              }
            : {
                commit: async (_tx, current) => ({
                  ...current,
                  revision: current.revision + 1,
                  state: "account_selection",
                  nextAction: {
                    type: "select_account",
                    accounts: [
                      ...candidates.map(({ installation }) => ({
                        id: String(installation.installationId),
                        providerId: state.providerId,
                        label: installation.accountLogin!,
                        ownership: "workspace" as const,
                        status: "connected" as const,
                      })),
                      {
                        id: "new",
                        providerId: state.providerId,
                        label: "Install on another GitHub account",
                        ownership: "workspace",
                        status: "connected",
                      },
                    ],
                  },
                }),
              };
      } else {
        const installationId = z.number().int().positive().safe().parse(state.installationId);
        const proof = provider
          ? await provider.authorizeInstallationBinding?.({ code: input.code!, installationId })
          : await authorizeGitHubInstallationBinding(settings, {
              code: input.code!,
              installationId,
            });
        if (!proof || !isConsistentGitHubBindingProof(proof, installationId))
          throw new Error("GitHub owner proof unavailable");
        const checkedAt = new Date();
        prepared = {
          commit: async (tx, current) => {
            if (state.providerId === "github-lens") {
              const registration = await commitGitHubLensConnect(deps, tx, {
                ...state,
                installationId,
                proof,
                checkedAt,
                expiresAt: new Date(state.iat * 1000 + lifetimeMs),
                nonce: state.nonce,
              });
              return {
                ...current,
                revision: current.revision + 1,
                state: "complete",
                nextAction: { type: "none" },
                account: {
                  id: `lens-registration:${registration.id}`,
                  providerId: "github-lens",
                  label: proof.installation.accountLogin!,
                  ownership: "workspace",
                  status: "connected",
                },
              };
            }
            const bound = await bindAuthorizedGitHubInstallationRepositories(tx, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              installationId,
              githubAccountId: proof.installation.accountId,
              accountLogin: proof.installation.accountLogin,
              accountType: proof.installation.accountType,
              linkedBySubjectId: state.subjectId,
              githubActorId: proof.actorId,
              githubActorLogin: proof.actorLogin,
              authorityKind: proof.authorityKind,
              authorityCheckedAt: checkedAt,
              authorityExpiresAt: new Date(state.iat * 1000 + lifetimeMs),
              authorityNonce: state.nonce,
              repositoryIds: proof.repositories.map((repo) => repo.id),
            });
            if (!bound) throw new Error("GitHub binding proof already consumed");
            return {
              ...current,
              revision: current.revision + 1,
              state: "complete",
              nextAction: { type: "none" },
              account: {
                id: `github-installation:${installationId}`,
                providerId: "github-app",
                label: proof.installation.accountLogin!,
                ownership: "workspace",
                status: "connected",
              },
            };
          },
        };
      }
      await finishConnectOperation(deps.db, state, { ...operation, commit: prepared.commit });
    }
  } catch {
    // Preserve unknown outcomes; never replay provider authorization to recover.
    if (!destination)
      return Response.json({ error: "Connection callback is invalid or expired" }, { status: 400 });
  }
  return new Response(null, { status: 302, headers: { Location: destination! } });
}
