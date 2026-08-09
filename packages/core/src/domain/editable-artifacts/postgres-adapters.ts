import type {
  PostgresEditableArtifactLiveReadStore,
  PostgresEditableArtifactLiveTicketStore,
  PostgresEditableArtifactStore,
} from "@opengeni/db/editable-artifacts";
import type {
  EditableArtifactAuthorizationRevisionPort,
  EditableArtifactScopeAuthorizationRevisionPort,
  EditableArtifactStorePort,
} from "./ports";
import type {
  EditableArtifactLiveReadPort,
  EditableArtifactLiveTicketStorePort,
} from "../../editable-artifact-live/ports";

/**
 * One-way nominal adapters over DB DTOs. The PostgreSQL implementations fully
 * validate and detach every returned value; only core applies branded domain
 * names to those already-validated wire-identical shapes.
 */
export function editableArtifactStorePortFromPostgres(
  store: PostgresEditableArtifactStore,
): EditableArtifactStorePort {
  return store as unknown as EditableArtifactStorePort;
}

export function editableArtifactAuthorizationRevisionPortFromPostgres(
  store: PostgresEditableArtifactStore,
): EditableArtifactAuthorizationRevisionPort {
  return store as unknown as EditableArtifactAuthorizationRevisionPort;
}

export function editableArtifactScopeAuthorizationRevisionPortFromPostgres(
  store: PostgresEditableArtifactStore,
): EditableArtifactScopeAuthorizationRevisionPort {
  return store as unknown as EditableArtifactScopeAuthorizationRevisionPort;
}

export function editableArtifactLiveReadPortFromPostgres(
  store: PostgresEditableArtifactLiveReadStore,
): EditableArtifactLiveReadPort {
  return store as unknown as EditableArtifactLiveReadPort;
}

export function editableArtifactLiveTicketStorePortFromPostgres(
  store: PostgresEditableArtifactLiveTicketStore,
): EditableArtifactLiveTicketStorePort {
  return store as unknown as EditableArtifactLiveTicketStorePort;
}
