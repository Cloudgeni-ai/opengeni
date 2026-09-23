import { useEffect, useRef, useState } from "react";
import type { AuthNeededItem } from "../timeline/types";
import { sessionAuthRecommendation } from "../session-auth-recommendation";
import {
  SessionMcpCapabilityCard,
  type SessionMcpCapabilityCardProps,
} from "./session-mcp-capability-card";

export type SessionConnectionRequestProps = Omit<
  SessionMcpCapabilityCardProps,
  "capabilityId" | "name" | "rationale"
> & {
  request: AuthNeededItem;
};

/** Resolve native reauthorization notices with the same exact-identity rules
 * as the console. Recommendations never supply endpoints or account authority. */
export function SessionConnectionRequest(props: SessionConnectionRequestProps) {
  const [client, setClient] = useState(props.client);
  const [generation, setGeneration] = useState(0);
  if (client !== props.client) {
    setClient(props.client);
    setGeneration(generation + 1);
  }
  return (
    <ScopedRequest
      key={`${generation}:${props.workspaceId}:${props.sessionId}:${props.request.id}`}
      {...props}
    />
  );
}

function ScopedRequest({ request, ...props }: SessionConnectionRequestProps) {
  const [resolved, setResolved] = useState<AuthNeededItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    let current = true;
    const event = requestRef.current;
    setResolved(null);
    setError(null);
    void props.client
      .listCapabilities(props.workspaceId)
      .then((catalog) => {
        if (!current) return;
        const recommendation = sessionAuthRecommendation(event, catalog.items);
        const candidate = catalog.items.find(
          (entry) => entry.id === recommendation?.capability?.id,
        );
        if (!recommendation || candidate?.kind !== "mcp" || candidate.authKind !== "oauth2") {
          setError(
            "This request could not be matched to one available OAuth integration. Review its connection settings before continuing.",
          );
          return;
        }
        setResolved(recommendation);
      })
      .catch(() => {
        if (current)
          setError("Couldn't load connection details. Retry to check the current integration.");
      });
    return () => {
      current = false;
    };
  }, [
    props.client,
    props.workspaceId,
    request.id,
    request.serverId,
    request.connectionId,
    request.authoritySource,
    request.reason,
    request.capability?.id,
    retry,
  ]);
  if (!resolved?.capability)
    return (
      <div className="og-session-capability-setup">
        <p role={error ? "alert" : "status"}>{error ?? "Loading connection details…"}</p>
        {error ? (
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        ) : null}
      </div>
    );
  return (
    <SessionMcpCapabilityCard
      {...props}
      capabilityId={resolved.capability.id}
      name={resolved.capability.name}
      rationale={resolved.capability.rationale}
    />
  );
}
