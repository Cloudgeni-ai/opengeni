// Where menus, dialogs, sheets and tooltips portal to. A page that owns the
// document (the web app) leaves it unset, so they portal to <body> as Radix
// does by default. An embedded app sets its own root, so its overlays stay
// inside the scoped stylesheet and carry the app's theme, not the host page's.
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

type PortalTarget = Element | DocumentFragment;

const PortalContainerContext = createContext<PortalTarget | null>(null);

export function PortalContainerProvider(props: {
  container: PortalTarget | null;
  children?: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={props.container}>
      {props.children}
    </PortalContainerContext.Provider>
  );
}

/** The provided portal target, or null for <body>. */
export function usePortalContainer(): PortalTarget | null {
  return useContext(PortalContainerContext);
}

type PortalProps = { container?: PortalTarget | null | undefined; children?: ReactNode };

/** A Radix `Portal` that targets the provided container unless given its own. */
export function containedPortal<P extends PortalProps>(Portal: ComponentType<P>): ComponentType<P> {
  function ContainedPortal(props: P) {
    const container = usePortalContainer();
    return <Portal {...props} container={props.container ?? container ?? undefined} />;
  }
  ContainedPortal.displayName = `Contained(${Portal.displayName ?? Portal.name ?? "Portal"})`;
  return ContainedPortal;
}
