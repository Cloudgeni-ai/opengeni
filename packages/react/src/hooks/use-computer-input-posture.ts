import { useCallback, useEffect, useRef, useState } from "react";
import {
  type EmbeddedComputerInteractionClientOverride,
  useEmbeddedComputerInteraction,
} from "../session-context";

type PostureSource = {
  client: ReturnType<typeof useEmbeddedComputerInteraction>["client"];
  key: string;
};

type PostureState = {
  source: PostureSource;
  nonce: number;
  inputAllowed: boolean | null;
  pending: boolean;
  error: Error | null;
};

/** Semantic-only targets need caller authority without opening a pixel stream.
 * A source change synchronously discards the previous posture. */
export function useComputerInputPosture(
  options: EmbeddedComputerInteractionClientOverride & {
    computerSessionId: string | null;
    controllerGeneration: string | null;
    enabled: boolean;
  },
) {
  const { client, workspaceId } = useEmbeddedComputerInteraction(options);
  const { computerSessionId, controllerGeneration, enabled } = options;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<PostureState | null>(null);
  const key = JSON.stringify([workspaceId, computerSessionId, controllerGeneration, enabled]);
  const sourceRef = useRef<PostureSource>({ client, key });
  if (sourceRef.current.client !== client || sourceRef.current.key !== key) {
    sourceRef.current = { client, key };
  }
  const source = sourceRef.current;
  const visible = state?.source === source && state.nonce === nonce ? state : null;
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !computerSessionId || !controllerGeneration) return;
    const controller = new AbortController();
    let disposed = false;
    setState({ source, nonce, inputAllowed: null, pending: true, error: null });
    void (async () => {
      try {
        if (!client.getComputerInputPosture) {
          throw new Error("Desktop input availability could not be verified.");
        }
        const posture = await client.getComputerInputPosture(workspaceId, computerSessionId, {
          signal: controller.signal,
          timeoutMs: 15_000,
        });
        if (disposed || sourceRef.current !== source) return;
        if (
          posture.computerSessionId !== computerSessionId ||
          posture.controllerGeneration !== controllerGeneration ||
          typeof posture.inputAllowed !== "boolean"
        ) {
          throw new Error("Desktop input availability belongs to a different controller.");
        }
        setState({
          source,
          nonce,
          inputAllowed: posture.inputAllowed,
          pending: false,
          error: null,
        });
      } catch (cause) {
        if (disposed || controller.signal.aborted || sourceRef.current !== source) return;
        setState({
          source,
          nonce,
          inputAllowed: null,
          pending: false,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [client, computerSessionId, controllerGeneration, enabled, nonce, source, workspaceId]);

  return {
    inputAllowed: visible?.inputAllowed ?? null,
    pending: enabled && (visible?.pending ?? true),
    error: visible?.error ?? null,
    refresh,
  };
}
