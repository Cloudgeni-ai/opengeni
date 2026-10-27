import type { SitePublication, WorkspaceArtifact } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import { useAppContext } from "../../app-context";
import { sitesClientConfig } from "../../lib/site-publishing";
import { sitePublishFormProps } from "./site-publish-form-props";
import { SitePublishPage } from "./site-publishing";
import { useSiteManagement } from "./site-settings";

/**
 * Publish to web for the Site on screen: the same form, permissions and
 * publication as the Site's Settings, as a page in place of the Site. Its
 * back link (and a successful Publish or Save) returns to the Site.
 */
export function SitePublishingPage({
  workspaceId,
  siteId,
  artifact,
  onPublication,
  onBack,
}: {
  workspaceId: string;
  siteId: string;
  artifact: WorkspaceArtifact;
  /** Every change to the publication, so the header shows it at once. */
  onPublication: (publication: SitePublication) => void;
  onBack: () => void;
}) {
  const { client, clientConfig } = useAppContext();
  // Sharing with the workspace (to publish an Only me Site) changes it here.
  const [shown, setShown] = useState<WorkspaceArtifact>(artifact);
  const management = useSiteManagement({
    workspaceId,
    siteId,
    artifact: shown,
    onArtifactChanged: setShown,
    onStatusChanged: () => undefined,
  });
  const { publication, audience } = management;
  // Focus moves into the form as it opens (what opened it is hidden now), and
  // to its title again when the loaded form replaces the loading one.
  const page = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const loaded = publication.load.state !== "loading";
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    const active = document.activeElement;
    if (opened.current && active && active !== document.body && active !== root) return;
    opened.current = true;
    (root.querySelector<HTMLElement>("[tabindex='-1']") ?? root).focus();
  }, [loaded]);
  return (
    <div
      ref={page}
      tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg outline-hidden"
    >
      <SitePublishPage
        {...sitePublishFormProps(management, {
          client,
          workspaceId,
          site: shown,
          sites: sitesClientConfig(clientConfig),
        })}
        layout="page"
        onPublication={(next) => {
          publication.setPublication(next);
          onPublication(next);
        }}
        onBack={onBack}
        onSubmitted={onBack}
        canManage={management.manageData}
      />
      {management.showAudience ? audience.dialog : null}
    </div>
  );
}
