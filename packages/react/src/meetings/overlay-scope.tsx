import { createContext, useContext, useState, type ReactNode } from "react";

import { StandaloneOverlayRoot } from "../ui/portal-container";

const InsideScope = createContext(false);

/**
 * Keeps a meetings component's menus and dialogs inside Opengeni's scoped
 * stylesheet and theme when a host page embeds it. They open in an `og-root`
 * layer under <body> that carries the component's tokens; inside an app that
 * already provides a portal container, that container is used. A component
 * inside another one (the transcript on a meeting's page) uses the outer
 * scope.
 */
export function MeetingsOverlayScope({ children }: { children: ReactNode }) {
  const inside = useContext(InsideScope);
  const [source, setSource] = useState<HTMLDivElement | null>(null);
  if (inside) return <>{children}</>;
  return (
    <div ref={setSource} style={{ display: "contents" }}>
      <InsideScope.Provider value>
        <StandaloneOverlayRoot source={source}>{children}</StandaloneOverlayRoot>
      </InsideScope.Provider>
    </div>
  );
}
