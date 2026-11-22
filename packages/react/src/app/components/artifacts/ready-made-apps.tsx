/**
 * Ready-made apps on the Artifacts page (the Apps tab, and the page's first
 * empty state): each added with one click, then opened, where it asks the
 * person to connect any tool it uses. The same apps as Capabilities'
 * Ready-made tab (packages/core/src/app-templates).
 */
import { useEffect, useState } from "react";
import type { AppTemplate } from "@opengeni/sdk";

import { CapabilityCatalogRow } from "../../../capability-catalog-row";
import { userErrorText } from "../../../ui/api-error";
import { DetailSection } from "../../../ui/detail-sheet";
import { useAppContext } from "../../app-context";
import { useNavigate } from "../../lib/navigation";
import { installReadyMadeApp, readyMadeAppNeedsTools } from "../../lib/ready-made-apps";
import { toast } from "../../lib/toast";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { ArtifactKindTile } from "./artifact-page-chrome";
import "../../../../styles/connect.css";

export function ReadyMadeApps({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<AppTemplate[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Suggestions only: when they can't load, the page goes on without them.
    client.listAppTemplates(workspaceId).then(
      (list) => live && setTemplates(list),
      () => live && setTemplates([]),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  if (!templates || templates.length === 0) return null;

  const add = async (template: AppTemplate) => {
    setAdding(template.key);
    try {
      const installed = await installReadyMadeApp(client, workspaceId, template);
      invalidateArtifactCatalog(client, workspaceId);
      if (installed.notInstalled.length > 0) {
        toast.warning(`${template.name} was added without some parts`, {
          description: installed.notInstalled.map((problem) => problem.reason).join(" "),
        });
      } else if (!installed.replayed) {
        toast.success(
          `Added ${template.name}`,
          readyMadeAppNeedsTools(template)
            ? { description: "Connect its tools to start using it." }
            : undefined,
        );
      }
      // The app itself asks for any tool it uses that isn't connected yet.
      void navigate({
        to: "/workspaces/$workspaceId/artifacts/$artifactId",
        params: { workspaceId, artifactId: installed.app.id },
      });
    } catch (error) {
      toast.error(`Couldn't add ${template.name}`, { description: userErrorText(error) });
    } finally {
      setAdding(null);
    }
  };

  return (
    <DetailSection title="Ready-made" className="pb-0">
      <div className="og-connection-catalog" data-columns="2">
        {templates.map((template) => (
          <CapabilityCatalogRow
            key={template.key}
            data-ready-made-app={template.key}
            name={template.name}
            description={template.description}
            title={template.description}
            icon={<ArtifactKindTile kind="site" />}
            status={adding === template.key ? "loading" : "available"}
            statusLabel={`Add ${template.name}`}
            disabled={adding !== null}
            onOpen={() => void add(template)}
          />
        ))}
      </div>
    </DetailSection>
  );
}
