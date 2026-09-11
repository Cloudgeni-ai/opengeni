import { useEffect, useRef, useState } from "react";
import {
  ConnectController,
  authorizeConnectAttempt,
  createBrowserConnectNavigation,
} from "@opengeni/connect";
import { ConnectPanel } from "@opengeni/react/connect";
import type { OpenGeniClient } from "@opengeni/sdk";
import "@opengeni/react/connect.css";

export function ConnectionsDialog({
  client,
  workspaceId,
  open,
  onClose,
}: {
  client: OpenGeniClient;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [transport] = useState(() => client.connectTransport());
  const [controller] = useState(() => new ConnectController(transport, workspaceId));
  const [error, setError] = useState(false);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-label="Connections"
      data-og-theme="light"
      className="m-auto max-h-[85dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-[#deded9] bg-white p-6 text-[#252a27] shadow-xl backdrop:bg-black/25"
    >
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[#deded9] px-3 py-1.5 text-sm"
        >
          Close
        </button>
      </div>
      {error ? (
        <p role="alert">Authorization could not finish. Check setup status before retrying.</p>
      ) : null}
      <ConnectPanel
        presentation="catalog"
        controller={controller}
        returnUrl={`${window.location.origin}/`}
        onAuthorize={(attempt) => {
          setError(false);
          return authorizeConnectAttempt(
            transport,
            attempt,
            createBrowserConnectNavigation(window),
            { mode: "popup" },
          )
            .then(async (result) => {
              if (result) await controller.recover(result.id);
            })
            .catch(() => setError(true));
        }}
      />
    </dialog>
  );
}
