import type { ReactNode } from "react";

/** The app's icon, else its initial on a tile. */
export function AppIcon({
  src,
  name,
  size = 22,
}: {
  src?: string | null;
  name: string;
  size?: number;
}) {
  return src ? (
    <img className="og-tc-app-icon" src={src} alt="" width={size} height={size} />
  ) : (
    <span className="og-tc-app-icon og-tc-app-icon-fallback" style={{ width: size, height: size }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * A computer with the agent at work on it: a window, a pointer moving to a
 * button, and the agent's mark in the corner. Shown before setting up.
 */
export function ComputerIllustration({ mark }: { mark?: ReactNode }) {
  return (
    <div className="og-tc-art og-tc-art-computer" aria-hidden>
      <svg viewBox="0 0 220 120" className="og-tc-art-svg">
        <rect className="og-tc-art-screen" x="30" y="8" width="160" height="98" rx="9" />
        <rect className="og-tc-art-window" x="46" y="22" width="128" height="70" rx="6" />
        <circle className="og-tc-art-dot" cx="56" cy="31" r="2.6" />
        <circle className="og-tc-art-dot" cx="64" cy="31" r="2.6" />
        <circle className="og-tc-art-dot" cx="72" cy="31" r="2.6" />
        <rect className="og-tc-art-line" x="56" y="44" width="78" height="6" rx="3" />
        <rect
          className="og-tc-art-line og-tc-art-line-soft"
          x="56"
          y="56"
          width="104"
          height="6"
          rx="3"
        />
        <rect
          className="og-tc-art-line og-tc-art-line-soft"
          x="56"
          y="68"
          width="62"
          height="6"
          rx="3"
        />
        <rect className="og-tc-art-button" x="128" y="72" width="36" height="13" rx="4" />
        <rect className="og-tc-art-stand" x="96" y="106" width="28" height="7" rx="2" />
        <g className="og-tc-art-pointer">
          <path d="M0 0l11 7.5-5 1.2-2.6 4.6z" />
        </g>
      </svg>
      {mark ? <span className="og-tc-art-mark">{mark}</span> : null}
    </div>
  );
}

/**
 * The row the person will find in System Settings: the app's icon and name,
 * and its switch, turning on. Once allowed, the switch stays on.
 */
export function SettingsRowIllustration({
  listName,
  appName,
  appIcon,
  allowed,
}: {
  listName: string;
  appName: string;
  appIcon?: string | null;
  allowed: boolean;
}) {
  return (
    <div
      className="og-tc-art og-tc-art-settings"
      data-allowed={allowed ? "" : undefined}
      aria-hidden
    >
      <div className="og-tc-settings-window">
        <div className="og-tc-settings-bar">
          <span />
          <span />
          <span />
          <b>{listName}</b>
        </div>
        <div className="og-tc-settings-row og-tc-settings-row-ghost">
          <span className="og-tc-app-icon og-tc-app-icon-ghost" />
          <span className="og-tc-settings-ghost-name" />
          <span className="og-tc-switch" data-on="" />
        </div>
        <div className="og-tc-settings-row og-tc-settings-row-target">
          <AppIcon src={appIcon ?? null} name={appName} size={20} />
          <span className="og-tc-settings-name">{appName}</span>
          <span className="og-tc-switch og-tc-switch-target" data-on={allowed ? "" : undefined} />
          <svg className="og-tc-settings-pointer" viewBox="0 0 16 16">
            <path d="M2 1l11 7-5 1-2.5 4.5z" />
          </svg>
        </div>
      </div>
    </div>
  );
}

/**
 * The question macOS asks the first time an app opens a guarded folder,
 * with the button to choose highlighted. Once allowed, it shows a check.
 */
export function FolderPromptIllustration({
  message,
  allow,
  dontAllow,
  appIcon,
  appName,
  allowed,
}: {
  message: string;
  allow: string;
  dontAllow: string;
  appIcon?: string | null;
  appName: string;
  allowed: boolean;
}) {
  return (
    <div className="og-tc-art og-tc-art-prompt" data-allowed={allowed ? "" : undefined} aria-hidden>
      <div className="og-tc-prompt-window">
        <span className="og-tc-prompt-icon">
          <svg viewBox="0 0 40 32" className="og-tc-prompt-folder">
            <path d="M2 6a3 3 0 0 1 3-3h10l4 4h16a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" />
          </svg>
          <span className="og-tc-prompt-badge">
            <AppIcon src={appIcon ?? null} name={appName} size={16} />
          </span>
        </span>
        <p className="og-tc-prompt-message">{message}</p>
        <div className="og-tc-prompt-buttons">
          <span>{dontAllow}</span>
          <span className="og-tc-prompt-allow">
            {allow}
            <svg className="og-tc-settings-pointer" viewBox="0 0 16 16">
              <path d="M2 1l11 7-5 1-2.5 4.5z" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A check that draws itself, for "allowed" and "all set". */
export function DoneIllustration() {
  return (
    <div className="og-tc-art og-tc-art-done" aria-hidden>
      <svg viewBox="0 0 64 64" className="og-tc-done-check">
        <circle cx="32" cy="32" r="30" />
        <path d="M19 33l9 9 18-20" />
      </svg>
    </div>
  );
}
