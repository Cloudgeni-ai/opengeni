import { useOpenGeniText } from "@opengeni/react/messages";
import { CLOUD_SANDBOX_LABEL, sessionComputeLabel } from "@opengeni/react/sandbox-label-model";
import { useEffect, useState } from "react";
import { useAccount } from "@/account";

const POLL_MS = 30_000;

/** Where this session's commands run, as the web timeline labels command rows. */
export function useSessionComputeLabel(workspaceId: string, sessionId: string): string {
  const t = useOpenGeniText();
  const { client } = useAccount();
  const [label, setLabel] = useState(() => CLOUD_SANDBOX_LABEL(t));
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await client.listMachines(workspaceId, {
          sessionId,
          signal: abort.signal,
        });
        if (!cancelled) setLabel(sessionComputeLabel(t, response.machines));
      } catch {
        // Keep the last label; machines need a permission some members lack.
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      abort.abort();
      clearInterval(timer);
    };
  }, [client, workspaceId, sessionId, t]);
  return label;
}
