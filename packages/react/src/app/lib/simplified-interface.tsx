import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The simplified interface: the same product with the same capabilities,
 * shown under the Geni name with fewer destinations, one model and credits
 * only. It is for people who arrive from gogeni.ai; everyone else gets the
 * full Opengeni console.
 *
 * It is presentation only, like the light or dark appearance. The flag is
 * kept in this browser, never sent to the server, and it changes no
 * permission: every route stays reachable by its address either way.
 */
export const SIMPLIFIED_INTERFACE_KEY = "opengeni.simplifiedInterface";
/** Landing-URL parameter that sets the flag (`?simplified_interface=1`, `=0` to clear). */
export const SIMPLIFIED_INTERFACE_PARAMETER = "simplified_interface";

const FULL_PRODUCT_NAME = "Opengeni";
const SIMPLIFIED_PRODUCT_NAME = "Geni";

/** The flag a stored or URL value names (`1`/`on`, `0`/`off`), or null when it names neither. */
export function parseSimplifiedInterface(value: string | null | undefined): boolean | null {
  if (value === "1" || value === "on") return true;
  if (value === "0" || value === "off") return false;
  return null;
}

/** What is stored for a flag value. */
export function storedSimplifiedInterfaceValue(simplified: boolean): string {
  return simplified ? "on" : "off";
}

/** The name people know the product by, with or without the simplified interface. */
export function interfaceProductName(simplified: boolean): string {
  return simplified ? SIMPLIFIED_PRODUCT_NAME : FULL_PRODUCT_NAME;
}

/** The flag this browser holds, or null when it never had one. */
export function readStoredSimplifiedInterface(): boolean | null {
  try {
    return parseSimplifiedInterface(window.localStorage.getItem(SIMPLIFIED_INTERFACE_KEY));
  } catch {
    return null;
  }
}

type SimplifiedInterfaceContextValue = {
  /** Whether the simplified interface is on. */
  simplified: boolean;
  /** False until this browser arrives with the flag or sets it itself. */
  chosen: boolean;
  productName: string;
  setSimplified: (value: boolean) => void;
};

const SimplifiedInterfaceContext = createContext<SimplifiedInterfaceContextValue>({
  simplified: false,
  chosen: false,
  productName: FULL_PRODUCT_NAME,
  setSimplified: () => {},
});

/**
 * Supplies the flag to the web app and mirrors it on `<html
 * data-og-simplified-interface>` for the stylesheet. Components rendered
 * without it (an embed in someone else's page) never use the simplified
 * interface.
 */
export function SimplifiedInterfaceProvider({ children }: { children: ReactNode }) {
  const [stored, updateStored] = useState<boolean | null>(() =>
    typeof window === "undefined" ? null : readStoredSimplifiedInterface(),
  );
  const simplified = stored === true;

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIMPLIFIED_INTERFACE_KEY || event.key === null) {
        updateStored(readStoredSimplifiedInterface());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (simplified) root.dataset.ogSimplifiedInterface = "";
    else delete root.dataset.ogSimplifiedInterface;
  }, [simplified]);

  const setSimplified = useCallback((value: boolean) => {
    updateStored(value);
    try {
      window.localStorage.setItem(SIMPLIFIED_INTERFACE_KEY, storedSimplifiedInterfaceValue(value));
    } catch {
      // A blocked storage area must not prevent changing this tab's interface.
    }
  }, []);

  const value = useMemo(
    () => ({
      simplified,
      chosen: stored !== null,
      productName: interfaceProductName(simplified),
      setSimplified,
    }),
    [simplified, stored, setSimplified],
  );

  return (
    <SimplifiedInterfaceContext.Provider value={value}>
      {children}
    </SimplifiedInterfaceContext.Provider>
  );
}

export function useSimplifiedInterface(): SimplifiedInterfaceContextValue {
  return useContext(SimplifiedInterfaceContext);
}
