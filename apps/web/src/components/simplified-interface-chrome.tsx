import { useSimplifiedInterface } from "@opengeni/react/app/lib/simplified-interface";
import { OpenGeniMessagesProvider } from "@opengeni/react/messages";
import { useEffect, type ReactNode } from "react";

import { applyInterfaceIcons, interfacePageTitle } from "@/lib/simplified-interface-landing";

/**
 * Names the product for the interface this browser shows: the built-in text
 * (`{product}`), the page title and the page icon. Without the simplified interface it
 * passes nothing, so the app renders exactly as it does without this
 * component.
 */
export function SimplifiedInterfaceChrome({ children }: { children: ReactNode }) {
  const { simplified, productName } = useSimplifiedInterface();

  useEffect(() => applyInterfaceIcons(document, simplified), [simplified]);

  useEffect(() => {
    const apply = () => {
      const next = interfacePageTitle(document.title, simplified);
      if (next !== document.title) document.title = next;
    };
    apply();
    // Routes and background notices rewrite the title; keep the name right.
    const title = document.querySelector("title");
    if (!title) return;
    const observer = new MutationObserver(apply);
    observer.observe(title, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [simplified]);

  return (
    <OpenGeniMessagesProvider productName={simplified ? productName : undefined}>
      {children}
    </OpenGeniMessagesProvider>
  );
}
