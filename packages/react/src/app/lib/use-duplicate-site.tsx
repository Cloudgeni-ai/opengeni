import type { WorkspaceArtifact } from "@opengeni/sdk";
import { useNavigate } from "./navigation";
import { useRef, useState } from "react";
import { toast } from "./toast";

import { useAppContext } from "../app-context";
import { userErrorText } from "../../ui/api-error";
import { invalidateArtifactCatalog } from "./use-artifact-catalog";

/**
 * Copies a Site's current version into a new Site the person owns. The copy
 * opens on its own page unless the caller keeps the person where they are
 * (`open: false`), when a toast offers to open it.
 */
export function useDuplicateSite(workspaceId: string) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const openCopy = (copy: WorkspaceArtifact) =>
    void navigate({
      to: "/workspaces/$workspaceId/artifacts/$artifactId",
      params: { workspaceId, artifactId: copy.id },
    });
  const duplicate = async (
    site: Readonly<{ id: string; title: string }>,
    { open = true }: { open?: boolean | undefined } = {},
  ): Promise<WorkspaceArtifact | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const { artifact: copy } = await client.duplicateWorkspaceArtifact(workspaceId, site.id, {
        idempotencyKey: crypto.randomUUID(),
      });
      invalidateArtifactCatalog(client, workspaceId);
      if (open) {
        toast(`Duplicated as “${copy.title}”`);
        openCopy(copy);
      } else {
        toast(`Duplicated as “${copy.title}”`, {
          action: { label: "Open", onClick: () => openCopy(copy) },
        });
      }
      return copy;
    } catch (error) {
      toast.error("Couldn't duplicate the Site", { description: userErrorText(error) });
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { duplicate, busy };
}
