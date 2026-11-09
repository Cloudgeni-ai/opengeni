import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import {
  autoTopUpDraft,
  parseAutoTopUpDraft,
  type AutoTopUpValues,
} from "./credit-protection-values";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { AutoTopUpForm, CreditAlertForm } = await import("./credit-protection-forms");
import type { AutoTopUpView } from "./credit-protection-forms";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

async function changeInput(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function settings(overrides: Partial<AutoTopUpView> = {}): AutoTopUpView {
  return {
    enabled: false,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
    spentThisMonthMicros: 25_000_000,
    status: "off",
    paymentMethod: { brand: "Visa", last4: "4242" },
    ...overrides,
  };
}

test("dollar inputs preserve cents, reject invalid amounts and enforce a cap covering one top-up", () => {
  const draft = autoTopUpDraft(settings());
  expect(parseAutoTopUpDraft({ ...draft, amount: "25.01" }).values?.amountMicros).toBe(25_010_000);
  for (const amount of ["", "-5", "1e3", "4.99", "10000.01", "25.001", "NaN"]) {
    expect(parseAutoTopUpDraft({ ...draft, amount }).values).toBeNull();
  }
  expect(parseAutoTopUpDraft({ ...draft, monthlyCap: "24.99" }).errors.monthlyCap).toContain(
    "one top-up",
  );
  expect(parseAutoTopUpDraft({ ...draft, threshold: "0" }).errors.threshold).toBeDefined();
});

test("alerts save USD micros and do not submit invalid or unchanged inputs", async () => {
  const onSave = mock(async (value: number) => value);
  await mount(<CreditAlertForm thresholdMicros={10_000_000} canManage onSave={onSave} />);
  await submit();
  expect(onSave).not.toHaveBeenCalled();
  await changeInput("Notify below (USD)", "15.25");
  await submit();
  expect(onSave).toHaveBeenCalledWith(15_250_000);
  expect(document.body.textContent).toContain("Alert threshold saved.");
  await changeInput("Notify below (USD)", "");
  await submit();
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(document.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
});

test("turning on is explicit, states the charge and cap, and saves once", async () => {
  const onSave = mock(async (value: AutoTopUpValues) => settings({ ...value, status: "ready" }));
  await mount(
    <AutoTopUpForm
      settings={settings()}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  expect(Boolean(document.querySelector('input[inputmode="decimal"]'))).toBe(false);
  await click("Set up");
  expect(onSave).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("charge your saved card off-session for $25");
  expect(document.body.textContent).toContain("credits plus applicable tax");
  expect(document.body.textContent).toContain("up to $100 total per UTC month");
  await click("Turn on automatic top-up");
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0]![0]).toEqual({
    enabled: true,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
  });
  await submit();
  expect(onSave).toHaveBeenCalledTimes(1);
});

test("a missing card offers setup instead of silently enabling top-ups", async () => {
  const onSave = mock(async () => settings());
  const setup = mock(async () => {});
  await mount(
    <AutoTopUpForm
      settings={settings({ paymentMethod: null })}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={setup}
    />,
  );
  await click("Set up");
  await submit();
  expect(onSave).not.toHaveBeenCalled();
  await click("Set up card");
  expect(setup).toHaveBeenCalledTimes(1);
});

test("retries retain request identity and prevent simultaneous saves", async () => {
  let reject!: (error: Error) => void;
  const onSave = mock(
    (_value: AutoTopUpValues, _key: string): Promise<AutoTopUpView> =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await mount(
    <AutoTopUpForm
      settings={settings({ enabled: true, status: "ready" })}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  await changeInput("Add each time (USD)", "50");
  await submit();
  await submit();
  expect(onSave).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Network unavailable")));
  await submit();
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(onSave.mock.calls[0]![1]).toBe(onSave.mock.calls[1]![1]);
  await act(async () => reject(new Error("Network unavailable")));
});

test("turning off remains available with invalid unfinished inputs", async () => {
  const onSave = mock(async (value: AutoTopUpValues) => settings({ ...value, status: "off" }));
  await mount(
    <AutoTopUpForm
      settings={settings({ enabled: true, status: "ready" })}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  await changeInput("Monthly limit (USD)", "");
  await click("Turn off automatic top-up");
  expect(onSave.mock.calls[0]![0]).toEqual({
    enabled: false,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
  });
});

test("read-only billing viewers have no payment or mutation controls", async () => {
  const onSave = mock(async () => settings());
  await mount(
    <AutoTopUpForm
      settings={settings({ enabled: true, status: "ready" })}
      canManage={false}
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  expect(Boolean(document.querySelector("button, input"))).toBe(false);
  expect(document.body.textContent).toContain("$100");
  await submit();
  expect(onSave).not.toHaveBeenCalled();
});

test("failed payments and caps remain visible independently of the opt-in toggle", async () => {
  const view = settings({ enabled: false, status: "payment_failed" });
  const setup = mock(async () => {});
  await mount(
    <AutoTopUpForm
      settings={view}
      canManage
      onSave={async () => view}
      onSetupPaymentMethod={setup}
    />,
  );
  expect(document.querySelector('[role="status"]')?.textContent).toContain("payment failed");
  await click("Update card");
  expect(setup).toHaveBeenCalledTimes(1);
  await act(async () =>
    root!.render(
      <AutoTopUpForm
        key="cap"
        settings={settings({ status: "cap_reached" })}
        canManage
        onSave={async () => view}
        onSetupPaymentMethod={async () => {}}
      />,
    ),
  );
  expect(document.querySelector('[role="status"]')?.textContent).toContain("monthly limit");
});

test("a pending result for the previous organization cannot replace the new organization's form", async () => {
  let resolve!: (value: AutoTopUpView) => void;
  await mount(
    <AutoTopUpForm
      key="org-a"
      settings={settings({ enabled: true, status: "ready" })}
      canManage
      onSave={() =>
        new Promise((done) => {
          resolve = done;
        })
      }
      onSetupPaymentMethod={async () => {}}
    />,
  );
  await changeInput("Add each time (USD)", "50");
  await submit();
  await act(async () =>
    root!.render(
      <AutoTopUpForm
        key="org-b"
        settings={settings({ enabled: true, thresholdMicros: 20_000_000, status: "ready" })}
        canManage
        onSave={async (value) => settings(value)}
        onSetupPaymentMethod={async () => {}}
      />,
    ),
  );
  await act(async () => resolve(settings({ enabled: true, amountMicros: 50_000_000 })));
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="When credits fall below (USD)"]')
      ?.value,
  ).toBe("20");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Add each time (USD)"]')?.value,
  ).toBe("25");
  expect(document.body.textContent).not.toContain("Automatic top-up saved.");
});

test("read-only alert settings show the threshold without exposing a save control", async () => {
  const onSave = mock(async (value: number) => value);
  await mount(<CreditAlertForm thresholdMicros={10_000_000} canManage={false} onSave={onSave} />);
  expect(Boolean(document.querySelector("button, input"))).toBe(false);
  expect(document.body.textContent).toContain("$10");
  await submit();
  expect(onSave).not.toHaveBeenCalled();
});

test("an enable whose response was lost can still be turned off explicitly", async () => {
  let serverEnabled = false;
  const onSave = mock(async (values: AutoTopUpValues) => {
    serverEnabled = values.enabled;
    if (values.enabled) throw new Error("Response lost");
    return settings(values);
  });
  await mount(
    <AutoTopUpForm
      settings={settings()}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  await click("Set up");
  await click("Turn on automatic top-up");
  expect(serverEnabled).toBe(true);
  expect(document.body.textContent).not.toContain("Automatic top-up is off.");
  await click("Turn off automatic top-up");
  expect(serverEnabled).toBe(false);
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Automatic top-up is off.");
});

test("turn-off is immediate but does not claim completion before the response", async () => {
  let resolve!: (value: AutoTopUpView) => void;
  const onSave = mock(
    (_value: AutoTopUpValues): Promise<AutoTopUpView> =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount(
    <AutoTopUpForm
      settings={settings({ enabled: true, status: "ready" })}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  await click("Turn off automatic top-up");
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0]![0].enabled).toBe(false);
  expect(document.body.textContent).not.toContain("Automatic top-up is off.");
  await act(async () => resolve(settings()));
  expect(document.body.textContent).toContain("Automatic top-up is off.");
  expect(document.querySelector('button[type="submit"]')).toBeNull();
  expect(document.body.textContent).toContain("Set up");
});

test("fresh card, spend and failure information is displayed without discarding a dirty amount", async () => {
  const onSave = mock(async (values: AutoTopUpValues) => settings(values));
  const props = { canManage: true, onSave, onSetupPaymentMethod: async () => {} };
  await mount(<AutoTopUpForm settings={settings({ paymentMethod: null })} {...props} />);
  await click("Set up");
  await changeInput("Add each time (USD)", "50");
  await act(async () =>
    root!.render(
      <AutoTopUpForm
        settings={settings({ spentThisMonthMicros: 75_000_000, status: "payment_failed" })}
        {...props}
      />,
    ),
  );
  expect(document.body.textContent).toContain("Visa ending in 4242");
  expect(document.body.textContent).toContain("$75 used this month");
  expect(document.body.textContent).toContain("payment failed");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Add each time (USD)"]')?.value,
  ).toBe("50");
  await click("Turn on automatic top-up");
  expect(onSave.mock.calls[0]![0].amountMicros).toBe(50_000_000);
});

test("pristine settings follow a same-organization refresh while dirty alert input is kept", async () => {
  const onSave = mock(async (value: number) => value);
  await mount(<CreditAlertForm thresholdMicros={10_000_000} canManage onSave={onSave} />);
  await act(async () =>
    root!.render(<CreditAlertForm thresholdMicros={20_000_000} canManage onSave={onSave} />),
  );
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Notify below (USD)"]')?.value,
  ).toBe("20");
  await changeInput("Notify below (USD)", "30");
  await act(async () =>
    root!.render(<CreditAlertForm thresholdMicros={40_000_000} canManage onSave={onSave} />),
  );
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Notify below (USD)"]')?.value,
  ).toBe("30");
  await submit();
  expect(onSave).toHaveBeenCalledWith(30_000_000);
  await act(async () =>
    root!.render(
      <CreditAlertForm thresholdMicros={50_000_000} canManage={false} onSave={onSave} />,
    ),
  );
  expect(document.body.textContent).toContain("$50");
});

test("every visible money label is included in its accessible name", async () => {
  await mount(
    <AutoTopUpForm
      settings={settings({ enabled: true, status: "ready" })}
      canManage
      onSave={async (values) => settings(values)}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  for (const input of document.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toBeTruthy();
    expect(input.getAttribute("aria-label")).toContain(label!.textContent!.trim());
  }
});

test("equivalent parent renders cannot roll back a confirmed enable or disable", async () => {
  const original = settings();
  const onSave = mock(async (values: AutoTopUpValues) =>
    settings({ ...values, status: values.enabled ? "ready" : "off" }),
  );
  const props = { canManage: true, onSave, onSetupPaymentMethod: async () => {} };
  await mount(<AutoTopUpForm settings={original} {...props} />);
  await click("Set up");
  await click("Turn on automatic top-up");
  await act(async () => root!.render(<AutoTopUpForm settings={settings()} {...props} />));
  expect(document.body.textContent).toContain("Turn off automatic top-up");
  expect(document.body.textContent).toContain("Automatic top-up saved.");
  const enabled = settings({ enabled: true, status: "ready" });
  await act(async () => root!.render(<AutoTopUpForm settings={enabled} {...props} />));
  await click("Turn off automatic top-up");
  await act(async () =>
    root!.render(
      <AutoTopUpForm settings={settings({ enabled: true, status: "ready" })} {...props} />,
    ),
  );
  expect(document.body.textContent).toContain("Automatic top-up is off.");
  expect(document.body.textContent).not.toContain("Turn off automatic top-up");
  expect(onSave).toHaveBeenCalledTimes(2);
});

test("a dirty amount does not overwrite an untouched monthly cap lowered by a refresh", async () => {
  const onSave = mock(async (values: AutoTopUpValues) => settings(values));
  const props = { canManage: true, onSave, onSetupPaymentMethod: async () => {} };
  await mount(<AutoTopUpForm settings={settings({ enabled: true })} {...props} />);
  await changeInput("Add each time (USD)", "30");
  await act(async () =>
    root!.render(
      <AutoTopUpForm
        settings={settings({ enabled: true, monthlyCapMicros: 50_000_000 })}
        {...props}
      />,
    ),
  );
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Monthly limit (USD)"]')?.value,
  ).toBe("50");
  await submit();
  expect(onSave.mock.calls[0]![0]).toEqual({
    enabled: true,
    thresholdMicros: 10_000_000,
    amountMicros: 30_000_000,
    monthlyCapMicros: 50_000_000,
  });
});

test("an invalid dirty field is kept while untouched values follow a refresh", async () => {
  const onSave = mock(async (values: AutoTopUpValues) => settings(values));
  const props = { canManage: true, onSave, onSetupPaymentMethod: async () => {} };
  await mount(<AutoTopUpForm settings={settings({ enabled: true })} {...props} />);
  await changeInput("Add each time (USD)", "");
  await act(async () =>
    root!.render(
      <AutoTopUpForm
        settings={settings({
          enabled: true,
          monthlyCapMicros: 50_000_000,
          thresholdMicros: 20_000_000,
        })}
        {...props}
      />,
    ),
  );
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Add each time (USD)"]')?.value,
  ).toBe("");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Monthly limit (USD)"]')?.value,
  ).toBe("50");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="When credits fall below (USD)"]')
      ?.value,
  ).toBe("20");
  await submit();
  expect(onSave).not.toHaveBeenCalled();
});

test("a zero alert threshold disables only low-balance warnings", async () => {
  const onSave = mock(async (value: number) => value);
  await mount(<CreditAlertForm thresholdMicros={10_000_000} canManage onSave={onSave} />);
  await changeInput("Notify below (USD)", "0");
  await submit();
  expect(onSave).toHaveBeenCalledWith(0);
  expect(document.body.textContent).toContain("$0 turns off low-balance warnings");
});

test("the cap includes pending charges and tax and cannot be lowered below them", async () => {
  const onSave = mock(async (values: AutoTopUpValues) => settings(values));
  await mount(
    <AutoTopUpForm
      settings={settings({ enabled: true, spentThisMonthMicros: 75_000_000 })}
      canManage
      onSave={onSave}
      onSetupPaymentMethod={async () => {}}
    />,
  );
  await changeInput("Monthly limit (USD)", "50");
  await submit();
  expect(onSave).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("limit cannot be below charges and reservations");
  expect(document.body.textContent).toContain("including pending charges and tax");
  await click("Turn off automatic top-up");
  expect(onSave.mock.calls[0]![0].enabled).toBe(false);
});
