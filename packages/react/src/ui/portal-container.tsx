// Where menus, dialogs, sheets and tooltips portal to. A page that owns the
// document (the web app) leaves it unset, so they portal to <body> as Radix
// does by default. An embedded app sets its own root, so its overlays stay
// inside the scoped stylesheet and carry the app's theme, not the host page's.
import { createContext, useContext, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { usePortalTokenStyle } from "../lib/use-portal-token-style";

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

/**
 * The overlays of a component that stands alone in a host page, such as a
 * panel in the host's own dialog. Its menus, dialogs and tooltips portal into
 * one `og-root` under <body> that carries the component's effective `--og-*`
 * tokens (`source` is the component's root), so the scoped stylesheet styles
 * them, they keep the host's theme, and the host's layout never clips them.
 * Inside an app that already provides a container, that container is used.
 */
export function StandaloneOverlayRoot(props: { source: HTMLElement | null; children?: ReactNode }) {
  const enclosing = usePortalContainer();
  const style = usePortalTokenStyle(enclosing ? null : props.source);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  if (enclosing) return <>{props.children}</>;
  return (
    <>
      {typeof document === "undefined"
        ? null
        : createPortal(
            <div ref={setLayer} className="og-root" data-og-overlays="" style={style} />,
            document.body,
          )}
      <PortalContainerProvider container={layer}>{props.children}</PortalContainerProvider>
    </>
  );
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
