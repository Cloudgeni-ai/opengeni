import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCapabilityFrame } from "./session-capability-frame";

const props = {
  name: "Writing style",
  subtitle: "Reviewed library skill",
  logo: null,
  typeLabel: "Skill",
  description: "Plain-language release notes with consistent structure and tone.",
  skill: true,
  expanded: false,
  complete: false,
  actionLabel: "Review skill",
  note: "Skill content is reviewed separately from permission to use any integration.",
  onOpen: () => {},
  onClose: () => {},
};

describe("compact conversation card states", () => {
  test("suggestion has the preview hierarchy, monogram and reassurance", () => {
    const html = renderToStaticMarkup(<SessionCapabilityFrame {...props} />);
    expect(html).toContain('data-state="suggested"');
    expect(html).toContain("og-session-capability-shell");
    expect(html).toContain("Guidance only · no account access");
    expect(html).toContain("Review skill");
    expect(html).toContain('aria-hidden="true">WR</span>');
    expect(html).not.toContain("sparkles");
  });

  test("setup keeps the compact shell and its dialog opener without an inline form", () => {
    const html = renderToStaticMarkup(
      <SessionCapabilityFrame {...props} expanded>
        <form aria-label="Skill review" />
      </SessionCapabilityFrame>,
    );
    expect(html).toContain('data-state="setup"');
    expect(html.match(/<h3>/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Skill review"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(">Review skill</button>");
  });

  test("completed Skill state uses the shared completion shell and removes setup actions and disclaimer", () => {
    const html = renderToStaticMarkup(<SessionCapabilityFrame {...props} complete />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Installed · Workspace");
    expect(html).toContain('data-state="complete"');
    expect(html).toContain("og-session-capability-shell");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(props.note);
    expect(html).not.toContain("green");
  });

  test("completed connection states describe verified availability without promising agent execution", () => {
    const html = renderToStaticMarkup(<SessionCapabilityFrame {...props} skill={false} complete />);
    expect(html).toContain("Connected · Available in this conversation");
    expect(html).not.toContain("agent continues");
  });
});
