import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// Register the DOM before React DOM and Radix load, so Radix uses real layout effects.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChoiceCard, ChoiceCards, ChoiceCardsSkeleton, selectableSurface } =
  await import("./choice-cards");
const { Field } = await import("./field");
const { SectionCardContext, SectionFrameReset } = await import("./section-variant");

afterAll(() => GlobalRegistrator.unregister());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function InviteRole(props: {
  onValueChange?: (value: string) => void;
  error?: string;
  variant?: "ring" | "radio" | "list";
}) {
  return (
    <ChoiceCards
      label="Organization role"
      defaultValue="member"
      onValueChange={props.onValueChange}
      error={props.error}
      variant={props.variant}
    >
      <ChoiceCard
        value="owner"
        title="Owner"
        description="Full control of the organization, billing and recovery."
        disabled
        disabledReason="Only an owner can invite another owner."
      />
      <ChoiceCard
        value="admin"
        title="Admin"
        description="Manages people, workspaces and shared connections."
      />
      <ChoiceCard
        value="member"
        title="Member"
        description="Uses the workspaces they're given access to."
      />
    </ChoiceCards>
  );
}

describe("ChoiceCards", () => {
  test("is a labelled radio group whose cards are named by their title", async () => {
    await act(async () => root.render(<InviteRole />));
    const group = container.querySelector('[role="radiogroup"]')!;
    const label = document.getElementById(group.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("Organization role");

    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios).toHaveLength(3);
    const member = radios[2]!;
    expect(document.getElementById(member.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Member",
    );
    expect(member.getAttribute("aria-checked")).toBe("true");
  });

  test("a locked option is disabled and describes why", async () => {
    await act(async () => root.render(<InviteRole />));
    const owner = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
    expect(owner.disabled).toBe(true);
    const described = owner
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("Only an owner can invite another owner.");
  });

  test("inside a Field group, the field's label names the group and its error describes it", async () => {
    await act(async () =>
      root.render(
        <Field group label="Who can use it?" error="Choose who can use this connection.">
          <ChoiceCards>
            <ChoiceCard value="workspace" title="Everyone in this workspace" />
            <ChoiceCard value="personal" title="Only me" />
          </ChoiceCards>
        </Field>,
      ),
    );
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Who can use it?",
    );
    expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Choose who can use this connection.",
    );
    expect(group.getAttribute("aria-invalid")).toBe("true");
  });

  test("clicking a card selects it and reports the value", async () => {
    const change = mock();
    await act(async () => root.render(<InviteRole onValueChange={change} />));
    const admin = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!;
    await act(async () => admin.click());
    expect(change).toHaveBeenCalledWith("admin");
    expect(admin.getAttribute("aria-checked")).toBe("true");
  });

  test("an error marks the group invalid and is announced with it", async () => {
    await act(async () => root.render(<InviteRole error="Choose a role." />));
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-invalid")).toBe("true");
    const describedBy = group.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe("Choose a role.");
  });

  test("only the ring version shows a check; radio and list show a radio dot", async () => {
    await act(async () => root.render(<InviteRole variant="ring" />));
    expect(container.querySelectorAll(".lucide-check")).toHaveLength(1);
    await act(async () => root.render(<InviteRole variant="list" />));
    expect(container.querySelectorAll(".lucide-check")).toHaveLength(0);
    expect(container.querySelector('[data-variant="list"]')).not.toBeNull();
  });

  test("inside a settings card the options are flat radio rows, never cards in a card", async () => {
    await act(async () =>
      root.render(
        <SectionCardContext.Provider value={true}>
          <InviteRole variant="ring" />
        </SectionCardContext.Provider>,
      ),
    );
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("data-variant")).toBe("list");
    expect(group.hasAttribute("data-rows")).toBe(true);
    expect(container.querySelectorAll(".lucide-check")).toHaveLength(0);
    for (const card of container.querySelectorAll('[data-slot="choice-card"]')) {
      expect(card.className).not.toMatch(/\bborder\b|rounded-/);
    }
  });

  test("a dialog opened from a card starts fresh and keeps its own cards", async () => {
    await act(async () =>
      root.render(
        <SectionCardContext.Provider value={true}>
          <SectionFrameReset>
            <InviteRole variant="ring" />
          </SectionFrameReset>
        </SectionCardContext.Provider>,
      ),
    );
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("data-variant")).toBe("ring");
    expect(group.hasAttribute("data-rows")).toBe(false);
  });

  test("the skeleton keeps the question visible and says it is loading", async () => {
    await act(async () => root.render(<ChoiceCardsSkeleton label="Organization role" count={3} />));
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("Organization role");
    expect(status.textContent).toContain("Loading options");
  });
});

describe("selectableSurface", () => {
  test("adds the brand border and fill only when selected", () => {
    expect(selectableSurface(false)).not.toContain("border-brand");
    expect(selectableSurface(true)).toContain("border-brand");
    expect(selectableSurface(true)).toContain("bg-brand/5");
  });
});
