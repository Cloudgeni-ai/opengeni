import {
  ListPersonalGitHubRepositoriesQuery,
  ListPersonalGitHubRepositoriesResponse,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubOAuthStartRequest,
  PersonalGitHubRepositoryId,
  PersonalGitHubRepositorySelectionState,
  ReplacePersonalGitHubRepositorySelectionsRequest,
  VerifyPersonalGitHubRepositorySelectionsRequest,
} from "@opengeni/contracts/personal-github";
import {
  ListGitHubRepositoryBranchesQuery,
  GitHubRepositoryBranchesResponse,
} from "@opengeni/contracts";
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
import { assertPersonalConnectionOwnerPrincipal } from "../connection-ownership";
import {
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
  verifyLivePersonalGitHubRepositories,
} from "../integrations/personal-github-repositories";

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
        connection: canonicalPersonalGitHubConnection(connections),
        reviewUrl: personalGitHubReviewUrl(deps.settings),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/github/oauth/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
    const payload = PersonalGitHubOAuthStartRequest.parse(await c.req.json().catch(() => ({})));
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
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
    const payload = PersonalGitHubOAuthStartRequest.omit({ connectionId: true }).parse(
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
      const query = ListPersonalGitHubRepositoriesQuery.parse(c.req.query());
      try {
        const selection = await loadRepositorySelectionState(deps, access.grant, connection);
        const page = await listLivePersonalGitHubRepositories(deps, {
          accountId: access.grant.accountId,
          workspaceId,
          subjectId: access.grant.subjectId,
          connectionId,
          expectedConnectionAuthorityGeneration: selection.connectionAuthorityGeneration,
          page: query.cursor,
          limit: query.limit,
        });
        const selectedAccessById = new Map(
          selection.repositories.map((repository) => [
            repository.repositoryId,
            repository.selectedAccess,
          ]),
        );
        return c.json(
          ListPersonalGitHubRepositoriesResponse.parse({
            repositories: page.repositories.map((repository) => ({
              ...repository,
              selectedAccess: selectedAccessById.get(repository.repositoryId) ?? null,
            })),
            nextCursor: page.nextPage,
            selection,
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
      const request = ReplacePersonalGitHubRepositorySelectionsRequest.parse(await c.req.json());
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
        });
        return c.json(PersonalGitHubRepositorySelectionState.parse(selection));
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
      const query = ListGitHubRepositoryBranchesQuery.parse(c.req.query());
      const repositoryId = PersonalGitHubRepositoryId.parse(c.req.param("repositoryId"));
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
      const request = VerifyPersonalGitHubRepositorySelectionsRequest.parse(await c.req.json());
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
        return c.json(PersonalGitHubRepositorySelectionState.parse(selection));
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
    return c.redirect(result.redirectTo, 302);
  });
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

function canonicalPersonalGitHubConnection<
  T extends { status: string; updatedAt: string; id: string },
>(connections: T[]): T | null {
  const statusRank: Record<string, number> = {
    active: 0,
    needs_reauth: 1,
    error: 2,
    revoked: 3,
  };
  return (
    [...connections].sort((left, right) => {
      const rank = (statusRank[left.status] ?? 4) - (statusRank[right.status] ?? 4);
      if (rank !== 0) return rank;
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : right.id.localeCompare(left.id);
    })[0] ?? null
  );
}
