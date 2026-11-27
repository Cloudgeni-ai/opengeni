// Enable: turns on one ready-made agent or app (components/enable). The page
// draws its own detail frame, like Get started.
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { useNavigate } from "@opengeni/react/app/lib/navigation";

import { EnablePage } from "@/components/enable/enable-page";
import { enableSubjectOf, type EnableSearch } from "@/components/enable/enable-subject";

/** Detail pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

export function EnableRoute({
  workspaceId,
  search,
}: {
  workspaceId: string;
  search: EnableSearch;
}) {
  const navigate = useNavigate();
  const subject = enableSubjectOf(search);
  const backTo = subject?.kind === "app" ? "apps" : "agents";
  const back = {
    label: subject?.kind === "app" ? "Apps" : "Agents",
    onClick: () =>
      void navigate({ href: `/workspaces/${encodeURIComponent(workspaceId)}/${backTo}` }),
  };
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      {subject ? (
        <EnablePage
          key={`${subject.kind}:${subject.templateKey}`}
          workspaceId={workspaceId}
          subject={subject}
          step={search.step}
          back={back}
        />
      ) : (
        <EmptyState
          variant="page"
          title="Nothing to set up here"
          description="Pick a ready-made agent or app to turn it on."
        />
      )}
    </ContentPage>
  );
}
