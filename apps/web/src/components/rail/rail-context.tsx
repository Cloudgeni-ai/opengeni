// Shared state for the left rail: collapsed (icon-only) persistence, the mobile
// overlay-drawer toggle, and the workspace-scoped navigation helpers every rail
// section reuses (open a workspace, start a new session, switch org/workspace).
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useAppContext } from "@/context";

const RAIL_COLLAPSED_KEY = "opengeni.rail.collapsed";
const RAIL_WIDTH_KEY = "opengeni.rail.width";
/** Below this viewport width the rail is an overlay drawer, not a fixed column. */
export const RAIL_DRAWER_BREAKPOINT = 1024;
/** Resize bounds for the expanded desktop rail (px). */
export const RAIL_MIN_WIDTH = 220;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_DEFAULT_WIDTH = 260;

function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return RAIL_DEFAULT_WIDTH;
  }
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
}

export type RailContextValue = {
  workspaceId: string;
  /** Icon-only rail (desktop). Ignored while the mobile drawer is in play. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  /** User-chosen expanded-rail width (px), clamped to [RAIL_MIN, RAIL_MAX]. */
  width: number;
  /** Set the expanded-rail width; persisted to localStorage (clamped). */
  setWidth: (width: number) => void;
  /** Whether the viewport is narrow enough to use the overlay drawer. */
  isMobile: boolean;
  /** Mobile overlay-drawer open state. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  /** Navigate to a workspace's sessions index (used by the switchers). */
  openWorkspace: (workspaceId: string) => void;
  /** Switch organization: navigate to the first workspace in the target org. */
  openOrg: (accountId: string) => void;
  /** Open a specific session in the current workspace. */
  openSession: (sessionId: string) => void;
  /** Start a new session (the sessions index composer). */
  startNewSession: () => void;
};

const RailContext = createContext<RailContextValue | null>(null);

export function useRail(): RailContextValue {
  const value = useContext(RailContext);
  if (!value) {
    throw new Error("Rail context is not ready");
  }
  return value;
}

function readStoredCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function readStoredWidth(): number {
  if (typeof window === "undefined") {
    return RAIL_DEFAULT_WIDTH;
  }
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    return raw ? clampRailWidth(Number.parseInt(raw, 10)) : RAIL_DEFAULT_WIDTH;
  } catch {
    return RAIL_DEFAULT_WIDTH;
  }
}

export function RailProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const appContext = useAppContext();
  const [collapsed, setCollapsedState] = useState<boolean>(() => readStoredCollapsed());
  const [width, setWidthState] = useState<number>(() => readStoredWidth());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < RAIL_DRAWER_BREAKPOINT : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const query = window.matchMedia(`(max-width: ${RAIL_DRAWER_BREAKPOINT - 1}px)`);
    const apply = () => setIsMobile(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, String(next));
    } catch {
      // localStorage may be unavailable (private mode); keep the in-memory value.
    }
  }, []);

  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  const setWidth = useCallback((next: number) => {
    const clamped = clampRailWidth(next);
    setWidthState(clamped);
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(clamped));
    } catch {
      // localStorage may be unavailable (private mode); keep the in-memory value.
    }
  }, []);

  const openWorkspace = useCallback(
    (nextWorkspaceId: string) => {
      appContext.resetSessionView();
      setDrawerOpen(false);
      void navigate({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: nextWorkspaceId },
      });
    },
    [appContext, navigate],
  );

  const openOrg = useCallback(
    (accountId: string) => {
      const target = appContext.workspaces.find((workspace) => workspace.accountId === accountId);
      if (!target) {
        return;
      }
      appContext.resetSessionView();
      setDrawerOpen(false);
      void navigate({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: target.id },
      });
    },
    [appContext, navigate],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      setDrawerOpen(false);
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId },
      });
    },
    [navigate, workspaceId],
  );

  const startNewSession = useCallback(() => {
    appContext.resetSessionView();
    setDrawerOpen(false);
    void navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId } });
  }, [appContext, navigate, workspaceId]);

  const value = useMemo<RailContextValue>(
    () => ({
      workspaceId,
      // The drawer always renders expanded content; collapse only applies to the
      // fixed desktop column.
      collapsed: isMobile ? false : collapsed,
      setCollapsed,
      toggleCollapsed,
      width,
      setWidth,
      isMobile,
      drawerOpen,
      setDrawerOpen,
      openWorkspace,
      openOrg,
      openSession,
      startNewSession,
    }),
    [
      workspaceId,
      collapsed,
      width,
      setWidth,
      isMobile,
      drawerOpen,
      setCollapsed,
      toggleCollapsed,
      openWorkspace,
      openOrg,
      openSession,
      startNewSession,
    ],
  );

  return <RailContext.Provider value={value}>{children}</RailContext.Provider>;
}
