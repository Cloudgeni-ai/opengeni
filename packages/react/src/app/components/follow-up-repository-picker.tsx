import { Suspense, type ReactNode } from "react";

import type { RepositoryContextPickerProps } from "./repository-picker";
import { ComposerMenuRowsSkeleton, lazyComposerPanel } from "../../ui/composer-menu";

type FollowUpRepositoryPickerProps = RepositoryContextPickerProps;

const LazyFollowUpRepositoryMenuBody = lazyComposerPanel(() =>
  import("./follow-up-repository-menu-body").then((module) => module.FollowUpRepositoryMenuBody),
);

export function FollowUpRepositoryMenuBody(
  props: FollowUpRepositoryPickerProps & { leading?: ReactNode | undefined },
) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-col">
          {props.leading}
          <ComposerMenuRowsSkeleton rows={4} label="Loading repositories" />
        </div>
      }
    >
      <LazyFollowUpRepositoryMenuBody {...props} />
    </Suspense>
  );
}
