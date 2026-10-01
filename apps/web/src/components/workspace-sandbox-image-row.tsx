import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Select } from "@/components/ui/select";
import { SettingRow } from "@/components/ui/setting-row";
import { apiErrorAdvice } from "@/lib/api-error";

type SandboxImagesClient = Pick<
  OpenGeniBrowserClient,
  "listWorkspaceSandboxImages" | "updateWorkspaceSettings"
>;

/** A failed action: what happened as the title, what to do under it. */
function actionFailed(what: string, error: unknown) {
  toast.error(what, { description: apiErrorAdvice(error) });
}

/** Hidden unless the deployment allowlists images a workspace may pick. */
export function WorkspaceSandboxImageRow({
  client,
  workspaceId,
  canManage,
}: {
  client: SandboxImagesClient;
  workspaceId: string;
  canManage: boolean;
}) {
  const [images, setImages] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void client
      .listWorkspaceSandboxImages(workspaceId)
      .then((response) => {
        if (cancelled) return;
        setImages(response.images);
        setSelected(response.selected);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);
  if (images.length === 0) return null;
  return (
    <SettingRow
      label="Sandbox image"
      description="The machine image new sandboxes in this workspace start from."
      controlWidth="select"
      control={
        <Select
          id="workspace-sandbox-image"
          aria-label="Sandbox image"
          className="h-8 bg-surface"
          disabled={!canManage || saving}
          value={selected ?? ""}
          onChange={(event) => {
            const next = event.target.value || null;
            setSaving(true);
            void client
              .updateWorkspaceSettings(workspaceId, { defaultSandboxImage: next })
              .then(() => {
                setSelected(next);
                toast.success("Sandbox image saved. Existing sandboxes switch at their next run.");
              })
              .catch((caught: unknown) => actionFailed("Couldn't save the sandbox image", caught))
              .finally(() => setSaving(false));
          }}
        >
          <option value="">Deployment default</option>
          {images.map((image) => (
            <option key={image} value={image}>
              {image}
            </option>
          ))}
        </Select>
      }
    />
  );
}
