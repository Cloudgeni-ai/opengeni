import type { CodexConnectionStatus } from "@opengeni/sdk";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../lib/app-api";
import { CodexConnect } from "./CodexConnect";

/**
 * First launch before any model is connected: Opengeni can't start a chat
 * without one, so Geni waits here until ChatGPT is signed in.
 */
export function Welcome({ workspaceId, onReady }: { workspaceId: string; onReady: () => void }) {
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let stopped = false;
    const check = () =>
      void client.codexStatus(workspaceId).then(
        (value) => {
          if (stopped) return;
          setStatus(value);
          // Connected somewhere else (another tab, the full app): carry on.
          if (value.connected) ready();
        },
        () => {},
      );
    check();
    const timer = setInterval(check, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const ready = () => {
    setStarting(true);
    onReady();
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="card-in w-full max-w-sm text-center">
        <div
          className="mx-auto flex h-20 w-20 items-center justify-center rounded-[28px] text-4xl shadow-lg"
          style={{ background: "linear-gradient(135deg, #a78bfa, #f472b6)" }}
        >
          ✨
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Meet Geni</h1>
        <p className="mt-2 text-sm text-[var(--app-muted)]">
          Your agents need a brain first. Connect your ChatGPT subscription and Geni is ready to go.
        </p>
        <div className="mt-6 text-left">
          {starting ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--app-muted)]">
              <Loader2 size={16} className="animate-spin" /> Waking Geni up…
            </div>
          ) : (
            <CodexConnect workspaceId={workspaceId} status={status} onConnected={ready} />
          )}
        </div>
      </div>
    </div>
  );
}
