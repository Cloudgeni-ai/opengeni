/**
 * The Apps page's Available list: ready-made apps not added here yet
 * (packages/core/src/app-templates). Choosing one never installs it. In the
 * Opengeni app it opens the app's Enable page (`onChoose`), the one place a
 * ready-made app is added; a host without Enable gets the install dialog,
 * with what the app is, a preview of it on sample records, the Skills it
 * turns on and the automations it adds.
 */
import { useEffect, useState } from "react";
import { compareAppPackageVersions } from "@opengeni/contracts";
import type { AppPackageStatus, AppTemplate } from "@opengeni/sdk";

import { CapabilityCatalogRow } from "../../../capability-catalog-row";
import { DetailSection } from "../../../ui/detail-sheet";
import { useAppContext } from "../../app-context";
import { installReadyMadeApp } from "../../lib/ready-made-apps";
import { toast } from "../../lib/toast";
import { userErrorText } from "../../../ui/api-error";
import {
  chosenAppPackage,
  InstallAppDialog,
  useOpenInstalledApp,
  type ChosenAppPackage,
} from "./app-package";
import { AppTemplatePreview } from "./app-template-preview";
import { ArtifactKindTile } from "./artifact-page-chrome";
import "../../../../styles/connect.css";

/**
 * Ready-made apps with no active app here from the same package. A
 * customized app gets no updates, so a newer version than it is offered
 * again, to add as a separate app.
 */
export function availableTemplates(
  templates: readonly AppTemplate[],
  installed: Iterable<AppPackageStatus>,
): AppTemplate[] {
  const active = new Map<string, AppPackageStatus[]>();
  for (const app of installed)
    if (app.packageId && !app.archived)
      active.set(app.packageId, [...(active.get(app.packageId) ?? []), app]);
  return templates.filter((template) => {
    const { packageId, packageVersion } = template.package as {
      packageId?: unknown;
      packageVersion?: unknown;
    };
    if (typeof packageId !== "string") return true;
    const apps = active.get(packageId);
    if (!apps) return true;
    return (
      typeof packageVersion === "string" &&
      apps.every(
        (app) =>
          app.customized &&
          compareAppPackageVersions(packageVersion, app.packageVersion ?? "0") > 0,
      )
    );
  });
}

export function AvailableApps({
  workspaceId,
  installed,
  onChoose,
}: {
  workspaceId: string;
  installed: readonly AppPackageStatus[];
  /** Opens a ready-made app's own setup page (Enable) instead of the install dialog. */
  onChoose?: ((templateKey: string) => void) | undefined;
}) {
  const { client } = useAppContext();
  const [templates, setTemplates] = useState<AppTemplate[] | null>(null);
  const [chosen, setChosen] = useState<{ template: AppTemplate; app: ChosenAppPackage } | null>(
    null,
  );
  const onInstalled = useOpenInstalledApp(workspaceId);
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
  const shown = templates ? availableTemplates(templates, installed) : [];
  if (shown.length === 0) return null;
  const choose = (template: AppTemplate) => {
    if (onChoose) {
      onChoose(template.key);
      return;
    }
    try {
      setChosen({ template, app: chosenAppPackage(template.package) });
    } catch (error) {
      toast.error(`Couldn't open ${template.name}`, { description: userErrorText(error) });
    }
  };
  return (
    <DetailSection title="Available" className="pb-0">
      <div className="og-connection-catalog" data-columns="2">
        {shown.map((template) => (
          <CapabilityCatalogRow
            key={template.key}
            data-ready-made-app={template.key}
            name={template.name}
            description={template.description}
            title={template.description}
            icon={<ArtifactKindTile kind="site" seed={template.key} />}
            status="available"
            statusLabel={`Preview ${template.name}`}
            onOpen={() => choose(template)}
          />
        ))}
      </div>
      {onChoose ? null : (
        <InstallAppDialog
          workspaceId={workspaceId}
          chosen={chosen?.app ?? null}
          about={chosen?.template.description}
          preview={
            chosen ? <AppTemplatePreview template={chosen.template} html={chosen.app.html} /> : null
          }
          onOpenChange={(open) => {
            if (!open) setChosen(null);
          }}
          install={(_app, demoData) =>
            installReadyMadeApp(client, workspaceId, chosen!.template, demoData)
          }
          onInstalled={onInstalled}
        />
      )}
    </DetailSection>
  );
}
