import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError } from "@opengeni/sdk";

import { CreateOrganizationForm } from "@/components/rail/create-organization-dialog";
import { additionalOrganizationCreationOutcomeUnknown } from "@/components/rail/switcher-block";
import { WorkspaceSwitcherTrigger } from "@/components/rail/workspace-switcher";
import type { Workspace } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const workspace = {
  id: "ws-1",
  kind: "shared",
  name: "cloudgeni",
  inferenceControl: { state: "active" },
} as Workspace;

describe("WorkspaceSwitcherTrigger", () => {
  test("forwards the Radix asChild ref onto the native button", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const ref: RefObject<HTMLButtonElement | null> = createRef();
    await act(async () => {
      root.render(
        <WorkspaceSwitcherTrigger
          ref={ref}
          activeWorkspace={workspace}
          activeOrganizationLabel="Org 049d0b24"
          personal={workspace.kind === "personal"}
          collapsed={false}
        />,
      );
    });
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.getAttribute("aria-label")).toContain("Switch workspace");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe("CreateOrganizationForm", () => {
  test("classifies only ambiguous mutation failures as outcome unknown", () => {
    expect(
      additionalOrganizationCreationOutcomeUnknown(
        new OpenGeniApiError(0, "", { mutation: true, outcomeUnknown: true }),
      ),
    ).toBe(true);
    expect(
      additionalOrganizationCreationOutcomeUnknown(
        new OpenGeniApiError(409, "limit reached", { mutation: true }),
      ),
    ).toBe(false);
  });

  test("explains the isolated organization graph and submits both names", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let submitted = 0;
    await act(async () => {
      root.render(
        <CreateOrganizationForm
          organizationName="Product team"
          workspaceName="Launch room"
          busy={false}
          onOrganizationNameChange={() => undefined}
          onWorkspaceNameChange={() => undefined}
          onCancel={() => undefined}
          onSubmit={() => {
            submitted += 1;
          }}
        />,
      );
    });

    expect(document.body.textContent).toContain("New organization");
    expect(document.body.textContent).toContain("Product team");
    expect(document.body.textContent).toContain("Launch room");
    expect(document.body.textContent).toContain("Your login stays the same");
    expect(document.body.textContent).toContain("nothing is copied");

    const submit = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Create organization"),
    );
    expect(submit).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      submit?.click();
    });
    expect(submitted).toBe(1);

    await act(async () => root.unmount());
    host.remove();
  });

  test("keeps a committed organization immutable while offering a safe open retry", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let submitted = 0;
    await act(async () => {
      root.render(
        <CreateOrganizationForm
          organizationName="Product team"
          workspaceName="Launch room"
          busy={false}
          creationState="committed"
          onOrganizationNameChange={() => undefined}
          onWorkspaceNameChange={() => undefined}
          onCancel={() => undefined}
          onSubmit={() => {
            submitted += 1;
          }}
        />,
      );
    });

    const inputs = Array.from(document.querySelectorAll("input"));
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.disabled)).toBe(true);
    const retry = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Try opening again"),
    );
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      retry?.click();
    });
    expect(submitted).toBe(1);

    await act(async () => root.unmount());
    host.remove();
  });

  test("freezes an outcome-unknown request and offers exact replay", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <CreateOrganizationForm
          organizationName="Product team"
          workspaceName="Launch room"
          busy={false}
          creationState="uncertain"
          onOrganizationNameChange={() => undefined}
          onWorkspaceNameChange={() => undefined}
          onCancel={() => undefined}
          onSubmit={() => undefined}
        />,
      );
    });

    expect(Array.from(document.querySelectorAll("input")).every((input) => input.disabled)).toBe(
      true,
    );
    expect(document.body.textContent).toContain("Check creation again");

    await act(async () => root.unmount());
    host.remove();
  });
});
