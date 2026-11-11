import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { useHostTheme } from "../lib/host-theme";
import { StandaloneOverlayRoot } from "../ui/portal-container";

const InsideScope = createContext(false);

/**
 * The root of a meetings component, as the embedded chat's root is: it takes
 * light or dark and its surfaces from the page it sits on, so its page
 * background, sticky bars and cards match a host page instead of Opengeni's
 * own greys (inside Opengeni's app, or under an embed root that already did
 * this, nothing changes). Its menus and dialogs stay inside Opengeni's scoped
 * stylesheet and theme: they open in an `og-root` layer under <body> that
 * carries the component's tokens; inside an app that already provides a
 * portal container, that container is used. A component inside another one
 * (the transcript on a meeting's page) uses the outer scope.
 */
export function MeetingsOverlayScope({ children }: { children: ReactNode }) {
  const inside = useContext(InsideScope);
  if (inside) return <>{children}</>;
  return <MeetingsRoot>{children}</MeetingsRoot>;
}

function MeetingsRoot({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [source, setSource] = useState<HTMLDivElement | null>(null);
  const hostTheme = useHostTheme(root, {});
  const ref = useCallback((node: HTMLDivElement | null) => {
    root.current = node;
    setSource(node);
  }, []);
  return (
    // `og-root` re-derives the stylesheet's colors from the tokens set here.
    <div
      ref={ref}
      className="og-root"
      style={{ ...hostTheme.style, display: "contents" }}
      data-og-theme={hostTheme.attribute}
      data-og-host-theme=""
    >
      <InsideScope.Provider value>
        <StandaloneOverlayRoot source={source}>{children}</StandaloneOverlayRoot>
      </InsideScope.Provider>
    </div>
  );
}
