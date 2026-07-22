import type { Settings } from "@opengeni/config";
import type { ConnectionCredentialsPort, SessionTurn } from "@opengeni/contracts";
import {
  buildConnectionTokenResolver,
  buildHostConnectionTokenResolver,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";

export function connectionTokenResolverForTurn(input: {
  db: Database;
  settings: Settings;
  connectionCredentials?: ConnectionCredentialsPort | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  attemptId: string;
  turn: SessionTurn;
}): (request: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult> {
  const hostResolver = input.connectionCredentials?.mcpCredentials;
  if (!hostResolver) {
    return buildConnectionTokenResolver(input.db, input.settings);
  }
  return buildHostConnectionTokenResolver(hostResolver, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId,
    turnId: input.turn.id,
    attemptId: input.attemptId,
    executionGeneration: input.turn.executionGeneration,
    initiator: input.turn.initiator,
    initiatorContext: input.turn.initiatorContext,
    surface: "model",
  });
}
