import type { ReactNode } from "react";

/** Shared page hierarchy for workspace, organization, and personal settings. */
export function SettingsPageHeader({
  title,
  description,
  context,
}: {
  title: string;
  description: string;
  context?: string;
}) {
  return (
    <header className="border-b border-border pb-6">
      {context ? <p className="mb-2 text-xs text-fg-subtle">{context}</p> : null}
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-6 text-fg-muted">{description}</p>
    </header>
  );
}

/** Section titles and actions align across settings without adding another card. */
export function SettingsSection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="flex flex-col gap-3 border-b border-border/70 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold text-fg">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className="min-w-0 pt-3">{children}</div>
    </section>
  );
}

/** An individual preference stays legible at narrow widths and keeps actions aligned. */
export function SettingsRow({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{title}</div>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-fg-muted">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center sm:justify-end">{action}</div>
    </div>
  );
}
