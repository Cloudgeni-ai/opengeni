// Optional surfaces the host turns on. The web app supplies its
// bundler-specific implementations (PDF.js worker, editable-artifact kernels)
// and its console-only account management as lazy components; a host that
// supplies nothing gets a plain fallback.
import { lazy, Suspense, useEffect, type ComponentType } from "react";

import { LoadingPanel } from "../components/common";
import { Link } from "./navigation";

import { useAppHost } from "./app-host";

export type PdfPreviewProps = { url: string; title: string };
export type EditableArtifactSurfaceProps = {
  workspaceId: string;
  artifactId: string;
  embedded?: boolean | undefined;
};

export type CodexSubscriptionsSurfaceProps = { workspaceId: string; canManage: boolean };

export type AppSurfaces = {
  pdfPreview: ComponentType<PdfPreviewProps>;
  editableArtifact: ComponentType<EditableArtifactSurfaceProps>;
  /** The workspace's ChatGPT subscription accounts, managed in the console. */
  codexSubscriptions: ComponentType<CodexSubscriptionsSurfaceProps>;
};

type Preloadable = { preload?: () => void };

/**
 * A lazy surface that can start loading before it renders, so a host's
 * split chunk does not add a second loading flash behind the panel that
 * shows it (see `usePreloadAppSurface`).
 */
export function lazySurface<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> & Required<Preloadable> {
  let pending: Promise<{ default: ComponentType<P> }> | null = null;
  const loadOnce = () => (pending ??= load());
  const component = lazy(loadOnce) as unknown as ComponentType<P> & Required<Preloadable>;
  component.preload = () => {
    void loadOnce().catch(() => {
      // Rendering retries the same import and reports its failure.
      pending = null;
    });
  };
  return component;
}

function useAppSurface<K extends keyof AppSurfaces>(name: K): AppSurfaces[K] | undefined {
  return useAppHost().surfaces?.[name];
}

/** Starts loading a registered lazy surface once `when` holds. */
export function usePreloadAppSurface(name: keyof AppSurfaces, when: boolean): void {
  const surface = useAppSurface(name) as (AppSurfaces[typeof name] & Preloadable) | undefined;
  useEffect(() => {
    if (when) surface?.preload?.();
  }, [surface, when]);
}

export function PdfPreviewSurface(props: PdfPreviewProps) {
  const Registered = useAppSurface("pdfPreview");
  if (Registered) return <Registered {...props} />;
  return (
    <a className="text-sm underline" href={props.url} target="_blank" rel="noreferrer">
      {props.title}
    </a>
  );
}

export function EditableArtifactSurface(props: EditableArtifactSurfaceProps) {
  const Registered = useAppSurface("editableArtifact");
  if (Registered) {
    // Its own boundary, so a cold load keeps the surrounding header and tabs.
    return (
      <Suspense fallback={<LoadingPanel label="Opening artifact" />}>
        <Registered {...props} />
      </Suspense>
    );
  }
  // A host without the editor opens the artifact in the web app.
  return (
    <section className="grid flex-1 place-items-center px-4 text-center">
      <div className="grid max-w-sm justify-items-center gap-3 text-sm text-fg-muted">
        <p>This artifact opens in the Opengeni web app.</p>
        <Link
          to="/workspaces/$workspaceId/artifacts/editable/$artifactId"
          params={{ workspaceId: props.workspaceId, artifactId: props.artifactId }}
          className="font-medium text-fg underline underline-offset-2"
        >
          Open artifact
        </Link>
      </div>
    </section>
  );
}

export function CodexSubscriptionsSurface(props: CodexSubscriptionsSurfaceProps) {
  const Registered = useAppSurface("codexSubscriptions");
  if (Registered) return <Registered {...props} />;
  return null;
}
