import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ArtifactLabelsProvider,
  ArtifactProblem,
  ArtifactViewerHeader,
  artifactLoadErrorView,
  DEFAULT_ARTIFACT_LABELS,
} from "../src/components/artifacts/artifact-chrome";
import { ArtifactSandbox } from "../src/components/artifacts/artifact-sandbox";

const translated = {
  close: "Lukk",
  back: "Tilbake",
  live: "Direkte",
  reloadSite: "Last inn på nytt",
  openFullScreen: "Fullskjerm",
  kindSubtitle: (kind: string) => `${kind} · delt`,
  toolCount: (count: number) => `${count} verktøy`,
  tryAgain: "Prøv igjen",
  siteErrors: {
    ...DEFAULT_ARTIFACT_LABELS.siteErrors,
    transient: { title: "Kunne ikke laste", message: "Midlertidig feil." },
  },
  reference: (id: string) => `Referanse: ${id}`,
};

describe("artifact labels", () => {
  test("hosts translate the viewer header, Site frame, and problem states", () => {
    const html = renderToStaticMarkup(
      <ArtifactLabelsProvider labels={translated}>
        <ArtifactViewerHeader kind="site" title="Dashboard" onClose={() => {}} onBack={() => {}} />
        <ArtifactSandbox html="<p>x</p>" title="Dashboard" connectedToolCount={2} />
        <ArtifactProblem
          view={artifactLoadErrorView(
            new OpenGeniApiError(503, "", { correlationId: "req-1" }),
            "site",
            { ...DEFAULT_ARTIFACT_LABELS, ...translated },
          )}
          onRetry={() => {}}
        />
      </ArtifactLabelsProvider>,
    );
    for (const text of [
      'aria-label="Lukk"',
      'aria-label="Tilbake"',
      "site · delt",
      "Direkte",
      'aria-label="Last inn på nytt"',
      'aria-label="Fullskjerm"',
      "2 verktøy",
      "Kunne ikke laste",
      "Referanse: req-1",
      "Prøv igjen",
    ]) {
      expect(html).toContain(text);
    }
    for (const english of ["Live", "Close", "Reload Site", "Try again", "Reference:"]) {
      expect(html).not.toContain(english);
    }
  });

  test("defaults stay English without a provider", () => {
    const html = renderToStaticMarkup(
      <ArtifactViewerHeader kind="document" title="Brief" onClose={() => {}} />,
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("Document · shared editor");
  });
});
