import { ManagedAuthSessionSetErrorCode } from "@opengeni/contracts/managed-auth-session-sets";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const counter = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value) ? value : null;
const slotId = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : null);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function sanitizeRaceResult(value: unknown) {
  const input = object(value);
  const code = ManagedAuthSessionSetErrorCode.safeParse(input.managedAuthCode);
  return {
    status:
      typeof input.status === "number" &&
      Number.isInteger(input.status) &&
      input.status >= 100 &&
      input.status <= 599
        ? input.status
        : null,
    managedAuthCode: code.success ? code.data : null,
    expectedGeneration: counter(input.expectedGeneration),
    expectedActorEpoch: counter(input.expectedActorEpoch),
    responseActorEpoch: counter(input.responseActorEpoch),
  };
}

export function sanitizeRaceProjection(value: unknown) {
  const input = object(value);
  return {
    generation: counter(input.generation),
    actorEpoch: counter(input.actorEpoch),
    selectedSlotId: slotId(input.selectedSlotId),
    slots: (Array.isArray(input.slots) ? input.slots : []).slice(0, 8).map((entry) => {
      const slot = object(entry);
      return {
        id: slotId(slot.id),
        state: slot.state === "active" || slot.state === "reauth_required" ? slot.state : null,
      };
    }),
  };
}

export function sanitizeRaceRequest(value: {
  method: string;
  pathname: string;
  actorEpoch: string | null;
  authorityHash: string | null;
}) {
  const exactRoutes = [
    "/v1/auth/session-set",
    "/v1/auth/session-set/select",
    "/v1/auth/session-set/logout-one",
    "/v1/auth/session-set/transactions",
    "/v1/auth/session-set/transactions/email-password",
    "/v1/auth/organization-onboarding",
  ];
  const segments = value.pathname.split("/");
  const workspaceRoute =
    segments[1] === "v1" && segments[2] === "workspaces" && slotId(segments[3]) !== null
      ? segments.slice(4).join("/")
      : null;
  const suffix = ["knowledge/entries/search", "new-session-draft", "sessions", "events"].find(
    (candidate) => candidate === workspaceRoute,
  );
  return {
    method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(value.method)
      ? value.method
      : "other",
    pathname: exactRoutes.includes(value.pathname)
      ? value.pathname
      : suffix
        ? `/v1/workspaces/:workspaceId/${suffix}`
        : "other",
    actorEpoch: counter(value.actorEpoch),
    authorityHash:
      typeof value.authorityHash === "string" && /^[a-f0-9]{64}$/u.test(value.authorityHash)
        ? value.authorityHash
        : null,
  };
}
