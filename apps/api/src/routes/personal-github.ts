import {
  ListPersonalGitHubRepositoriesQuery,
  ListPersonalGitHubRepositoriesResponse,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubOAuthStartRequest,
  PersonalGitHubRepositoryId,
  PersonalGitHubRepositorySelectionState,
  ReplacePersonalGitHubRepositorySelectionsRequest,
  VerifyPersonalGitHubRepositorySelectionsRequest,
  personalGitHubAllRepositoriesEffectiveAccess,
} from "@opengeni/contracts/personal-github";
import {
  ListGitHubRepositoryBranchesQuery,
  GitHubRepositoryBranchesResponse,
} from "@opengeni/contracts/github-repository-contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import {
  getPersonalGitHubRepositorySelectionState,
  PersonalGitHubRepositorySelectionChangedError,
  PersonalGitHubRepositorySelectionIdempotencyError,
  PersonalGitHubRepositorySelectionUnavailableError,
  replacePersonalGitHubRepositorySelections,
  verifyPersonalGitHubRepositorySelections,
  type PersonalGitHubRepositorySelectionState as DbPersonalGitHubRepositorySelectionState,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import {
  assertPersonalConnectionOwnerPrincipal,
  requireLegacyOAuthActor,
} from "../connection-ownership";
import {
  canonicalPersonalGitHubConnection,
  completePersonalGitHubOAuthCallback,
  listPersonalGitHubConnections,
  personalGitHubReviewUrl,
  startPersonalGitHubOAuth,
} from "../integrations/personal-github";
import {
  listLivePersonalGitHubRepositoryBranches,
  listLivePersonalGitHubRepositories,
  personalGitHubRepositoryProviderHttpError,
  PersonalGitHubRepositoryProviderError,
  requirePersonalGitHubRepositoryConnection,
  searchLivePersonalGitHubRepositories,
  verifyLivePersonalGitHubRepositories,
} from "../integrations/personal-github-repositories";
import { parseRequestBody, parseRequestJson, parseRequestQuery } from "../http/request-body";
import { parsePathParam } from "../http/path-identifier";

export function registerPersonalGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/connections/github", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    const connections = await listPersonalGitHubConnections(deps, {
      workspaceId,
      subjectId: grant.subjectId,
    });
    return c.json(
      PersonalGitHubConnectionStatusResponse.parse({
        enabled: deps.settings.githubPersonalOauthEnabled,
        allRepositoriesAvailable:
          deps.settings.githubPersonalOauthEnabled &&
          deps.settings.githubPersonalAllRepositoriesEnabled,
        connection: canonicalPersonalGitHubConnection(connections),
        reviewUrl: personalGitHubReviewUrl(deps.settings),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/github/oauth/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    requireLegacyOAuthActor(access);
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
    const payload = parseRequestBody(
      PersonalGitHubOAuthStartRequest,
      await c.req.json().catch(() => ({})),
    );
    return c.json(
      await startPersonalGitHubOAuth(deps, {
        access,
        workspaceId,
        ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
        ...(payload.returnPath ? { returnPath: payload.returnPath } : {}),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/:connectionId/github/reconnect", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    requireLegacyOAuthActor(access);
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
    const payload = parseRequestBody(
      PersonalGitHubOAuthStartRequest.omit({ connectionId: true }),
      await c.req.json().catch(() => ({})),
    );
    return c.json(
      await startPersonalGitHubOAuth(deps, {
        access,
        workspaceId,
        connectionId: c.req.param("connectionId"),
        ...(payload.returnPath ? { returnPath: payload.returnPath } : {}),
      }),
    );
  });

  app.get(
    "/v1/workspaces/:workspaceId/connections/:connectionId/github/repositories",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const connectionId = c.req.param("connectionId");
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:read",
      );
      assertPersonalConnectionOwnerPrincipal(access, "My GitHub repositories");
      const connection = await requirePersonalGitHubRepositoryConnection(deps, {
        accountId: access.grant.accountId,
        workspaceId,
        subjectId: access.grant.subjectId,
        connectionId,
      });
      const query = parseRequestQuery(ListPersonalGitHubRepositoriesQuery, c.req.query());
      try {
        const selection = await loadRepositorySelectionState(deps, access.grant, connection);
        const listInput = {
          accountId: access.grant.accountId,
          workspaceId,
          subjectId: access.grant.subjectId,
          connectionId,
          expectedConnectionAuthorityGeneration: selection.connectionAuthorityGeneration,
          limit: query.limit,
        };
        const page = query.query
          ? {
              ...(await searchLivePersonalGitHubRepositories(deps, {
                ...listInput,
                query: query.query,
              })),
              nextPage: null,
            }
          : await listLivePersonalGitHubRepositories(deps, { ...listInput, page: query.cursor });
        const selectedAccessById = new Map(
          selection.repositories.map((repository) => [
            repository.repositoryId,
            repository.selectedAccess,
          ]),
        );
        // A mode saved while the deployment allowed it is not used once it no longer does.
        const allRepositoriesAccess =
          deps.settings.githubPersonalOauthEnabled &&
          deps.settings.githubPersonalAllRepositoriesEnabled
            ? selection.allRepositoriesAccess
            : null;
        return c.json(
          ListPersonalGitHubRepositoriesResponse.parse({
            // `selectedAccess` stays the saved choice; in All my repositories
            // every listed repository is usable at `effectiveAccess`.
            repositories: page.repositories.map((repository) => {
              const selectedAccess = selectedAccessById.get(repository.repositoryId) ?? null;
              return {
                ...repository,
                selectedAccess,
                effectiveAccess: allRepositoriesAccess
                  ? personalGitHubAllRepositoriesEffectiveAccess(allRepositoriesAccess, repository)
                  : selectedAccess,
              };
            }),
            nextCursor: page.nextPage,
            selection: publicSelectionState(selection),
          }),
        );
      } catch (error) {
        throw personalGitHubRepositoryRouteError(error);
      }
    },
  );

  app.put(
    "/v1/workspaces/:workspaceId/connections/:connectionId/github/repositories",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const connectionId = c.req.param("connectionId");
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      assertPersonalConnectionOwnerPrincipal(access, "My GitHub repositories");
      const connection = await requirePersonalGitHubRepositoryConnection(deps, {
        accountId: access.grant.accountId,
        workspaceId,
        subjectId: access.grant.subjectId,
        connectionId,
      });
      const request = await parseRequestJson(c, ReplacePersonalGitHubRepositorySelectionsRequest);
      if (
        request.allRepositoriesAccess &&
        !(
          deps.settings.githubPersonalOauthEnabled &&
          deps.settings.githubPersonalAllRepositoriesEnabled
        )
      ) {
        throw new HTTPException(409, {
          message:
            "All my repositories is not available on this deployment yet. Choose repositories instead.",
        });
      }
      try {
        const current = await loadRepositorySelectionState(deps, access.grant, connection);
        assertRepositoryConnectionAuthorityFence(current, request);
        const verified = await verifyLivePersonalGitHubRepositories(deps, {
          accountId: access.grant.accountId,
          workspaceId,
          subjectId: access.grant.subjectId,
          connectionId,
          expectedConnectionAuthorityGeneration: request.expectedConnectionAuthorityGeneration,
          repositories: request.repositories,
          skipUnavailable: Boolean(request.allRepositoriesAccess),
        });
        const lastVerifiedAt = new Date().toISOString();
        const selection = await replacePersonalGitHubRepositorySelections(deps.db, {
          accountId: access.grant.accountId,
          originWorkspaceId: connection.workspaceId,
          subjectId: access.grant.subjectId,
          connectionId,
          expectedConnectionAuthorityGeneration: request.expectedConnectionAuthorityGeneration,
          expectedSelectionGeneration: request.expectedSelectionGeneration,
          idempotencyKey: request.idempotencyKey,
          repositories: verified.map((repository) => ({ ...repository, lastVerifiedAt })),
          ...(request.allRepositoriesAccess !== undefined
            ? { allRepositoriesAccess: request.allRepositoriesAccess }
            : {}),
        });
        return c.json(
          PersonalGitHubRepositorySelectionState.parse(publicSelectionState(selection)),
        );
      } catch (error) {
        throw personalGitHubRepositoryRouteError(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/connections/:connectionId/github/repositories/:repositoryId/branches",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const connectionId = c.req.param("connectionId");
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:read",
      );
      assertPersonalConnectionOwnerPrincipal(access, "My GitHub repositories");
      const query = parseRequestQuery(ListGitHubRepositoryBranchesQuery, c.req.query());
      const repositoryId = parsePathParam(c, "repositoryId", PersonalGitHubRepositoryId);
      try {
        return c.json(
          GitHubRepositoryBranchesResponse.parse(
            await listLivePersonalGitHubRepositoryBranches(deps, {
              accountId: access.grant.accountId,
              workspaceId,
              subjectId: access.grant.subjectId,
              connectionId,
              repositoryId,
              query,
            }),
          ),
        );
      } catch (error) {
        throw personalGitHubRepositoryRouteError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/connections/:connectionId/github/repositories/verify",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const connectionId = c.req.param("connectionId");
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      assertPersonalConnectionOwnerPrincipal(access, "My GitHub repositories");
      const connection = await requirePersonalGitHubRepositoryConnection(deps, {
        accountId: access.grant.accountId,
        workspaceId,
        subjectId: access.grant.subjectId,
        connectionId,
      });
      const request = await parseRequestJson(c, VerifyPersonalGitHubRepositorySelectionsRequest);
      try {
        const current = await loadRepositorySelectionState(deps, access.grant, connection);
        assertRepositoryConnectionAuthorityFence(current, request);
        const verified = await verifyLivePersonalGitHubRepositories(deps, {
          accountId: access.grant.accountId,
          workspaceId,
          subjectId: access.grant.subjectId,
          connectionId,
          expectedConnectionAuthorityGeneration: request.expectedConnectionAuthorityGeneration,
          repositories: current.repositories.map((repository) => ({
            repositoryId: repository.repositoryId,
            fullName: repository.fullName,
            access: repository.selectedAccess,
          })),
        });
        const lastVerifiedAt = new Date().toISOString();
        const selection = await verifyPersonalGitHubRepositorySelections(deps.db, {
          accountId: access.grant.accountId,
          originWorkspaceId: connection.workspaceId,
          subjectId: access.grant.subjectId,
          connectionId,
          expectedConnectionAuthorityGeneration: request.expectedConnectionAuthorityGeneration,
          expectedSelectionGeneration: request.expectedSelectionGeneration,
          idempotencyKey: request.idempotencyKey,
          repositories: verified.map((repository) => ({ ...repository, lastVerifiedAt })),
        });
        return c.json(
          PersonalGitHubRepositorySelectionState.parse(publicSelectionState(selection)),
        );
      } catch (error) {
        throw personalGitHubRepositoryRouteError(error);
      }
    },
  );

  app.get("/v1/integrations/github-personal/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const result = await completePersonalGitHubOAuthCallback(deps, {
      requestUrl: c.req.url,
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
      ...(error ? { error } : {}),
    });
    if (result.exactReturn)
      return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
    return c.redirect(result.redirectTo, 302);
  });
}

/** The selection as clients see it; the mode's generation is server-only. */
function publicSelectionState(
  state: DbPersonalGitHubRepositorySelectionState,
): Omit<DbPersonalGitHubRepositorySelectionState, "allRepositoriesGeneration"> {
  const { allRepositoriesGeneration: _generation, ...rest } = state;
  return rest;
}

async function loadRepositorySelectionState(
  deps: ApiRouteDeps,
  grant: { accountId: string; subjectId: string },
  connection: { id: string; workspaceId: string },
): Promise<DbPersonalGitHubRepositorySelectionState> {
  const state = await getPersonalGitHubRepositorySelectionState(deps.db, {
    accountId: grant.accountId,
    originWorkspaceId: connection.workspaceId,
    subjectId: grant.subjectId,
    connectionId: connection.id,
  });
  if (!state) throw new PersonalGitHubRepositorySelectionUnavailableError();
  return state;
}

function assertRepositoryConnectionAuthorityFence(
  current: DbPersonalGitHubRepositorySelectionState,
  expected: {
    expectedConnectionAuthorityGeneration: number;
  },
): void {
  if (current.connectionAuthorityGeneration !== expected.expectedConnectionAuthorityGeneration) {
    throw new PersonalGitHubRepositorySelectionChangedError();
  }
}

function personalGitHubRepositoryRouteError(error: unknown): Error {
  if (error instanceof PersonalGitHubRepositoryProviderError) {
    return personalGitHubRepositoryProviderHttpError(error);
  }
  if (error instanceof PersonalGitHubRepositorySelectionChangedError) {
    return new HTTPException(409, {
      message: "personal GitHub repository selection changed; refresh and try again",
    });
  }
  if (error instanceof PersonalGitHubRepositorySelectionIdempotencyError) {
    return new HTTPException(409, {
      message: "personal GitHub repository idempotency key was already used",
    });
  }
  if (error instanceof PersonalGitHubRepositorySelectionUnavailableError) {
    return new HTTPException(404, { message: "personal GitHub connection not found" });
  }
  return error instanceof Error ? error : new Error("personal GitHub repository request failed");
}
