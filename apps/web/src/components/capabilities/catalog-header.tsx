import { createContext, useContext, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

/** Hosts each tab’s existing action without duplicating its state or permissions. */
export const CatalogActionContext = createContext<{
  target: HTMLElement | null;
  activeTitle: string;
} | null>(null);

/** One action toolbar rhythm across all Capabilities tabs. */
export function CatalogHeader({
  title,
  action,
  headingRef,
  hidden = false,
}: {
  title: string;
  action: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  hidden?: boolean;
}) {
  const toolbar = useContext(CatalogActionContext);
  if (toolbar) {
    return (
      <>
        <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="sr-only">
          {title}
        </h2>
        {!hidden && toolbar.target && toolbar.activeTitle === title
          ? createPortal(action, toolbar.target)
          : null}
      </>
    );
  }
  return (
    <div hidden={hidden} className="mb-6 mt-6 flex flex-wrap items-center justify-end gap-4">
      <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="sr-only">
        {title}
      </h2>
      {action}
    </div>
  );
}
