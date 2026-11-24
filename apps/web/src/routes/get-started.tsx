// Get started: the guided setups (components/get-started). The page draws its
// own detail frame, like Agents.
import { ContentPage } from "@opengeni/react/ui/content-layout";

import { GetStartedPage } from "@/components/get-started/get-started-page";

/** Detail pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

export function GetStartedRoute({
  workspaceId,
  setup,
}: {
  workspaceId: string;
  setup?: string | undefined;
}) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <GetStartedPage workspaceId={workspaceId} setupKey={setup} />
    </ContentPage>
  );
}
