import { expect, test } from "bun:test";
import { reason, tick, type Ports } from "../docs/merge-batcher-admin/minimal-watchdog";

const now = 2_000_000;
const live = {
  state: "running",
  controlObservedAt: now,
  consecutiveUnclassifiedFailures: 0,
  progressSchema: "batcher-progress/v1",
  lastSuccessfulCycleAt: now,
  firstObservationDeferredAt: null,
  consecutiveObservationDeferrals: 0,
  runtimeStartedAt: 0,
  cycleStartedAt: null,
  cycleDeadlineAt: null,
};
test("fresh control observation and successful cycle are both required", () => {
  expect(reason(live, now)).toBeNull();
  expect(reason({ ...live, state: "holding" }, now)).toBeNull();
  expect(reason({ ...live, state: "unexpected" }, now)).toBe("unavailable");
  expect(reason({ ...live, controlObservedAt: now - 899_999 }, now)).toBeNull();
  expect(reason({ ...live, controlObservedAt: now - 900_000 }, now)).toBe("stale");
  expect(reason({ ...live, state: "stopped" }, now)).toBe("stopped");
  expect(reason({ ...live, state: "draining" }, now)).toBe("stopped");
  expect(reason({ ...live, consecutiveUnclassifiedFailures: 3 }, now)).toBe("crash-loop");
  for (const value of [
    null,
    {},
    { ...live, controlObservedAt: now + 1 },
    { ...live, controlObservedAt: null },
    { ...live, consecutiveUnclassifiedFailures: -1 },
  ])
    expect(reason(value, now)).toBe("unavailable");
});

function fixture() {
  let claimed = false;
  const calls: string[] = [];
  const ports: Ports = {
    now: () => now,
    verifyBinding: async () => {
      calls.push("binding");
    },
    status: async () => ({ ...live, state: "stopped" }),
    claim: async () => {
      calls.push("claim");
      if (claimed) return false;
      claimed = true;
      return true;
    },
    off: async () => {
      calls.push("off");
    },
    record: async (event) => {
      calls.push(event.outcome);
    },
  };
  return { ports, calls };
}
test("healthy polls never claim or invoke OFF", async () => {
  const { ports, calls } = fixture();
  ports.status = async () => live;
  expect(await tick(ports)).toBe("healthy");
  expect(calls).toEqual(["binding", "healthy"]);
});
test("OFF success is necessary for Manual; subsequent execution never repeats it", async () => {
  const { ports, calls } = fixture();
  expect(await tick(ports)).toBe("manual");
  expect(await tick(ports)).toBe("held");
  expect(calls.filter((x) => x === "off")).toHaveLength(1);
});
test("unknown write/drain failure remains held across a later invocation", async () => {
  const { ports, calls } = fixture();
  ports.off = async () => {
    calls.push("off");
    throw Error("unknown write");
  };
  expect(await tick(ports)).toBe("held");
  expect(await tick(ports)).toBe("held");
  expect(calls.filter((x) => x === "off")).toHaveLength(1);
  expect(calls).not.toContain("manual");
});
test("consumed claim may finish proven reverse stages without another OFF", async () => {
  const { ports, calls } = fixture();
  ports.off = async () => {
    calls.push("off");
    throw Error("stopped; provider read failed");
  };
  ports.resumeOff = async () => {
    calls.push("resume-proof-only");
  };
  expect(await tick(ports)).toBe("held");
  expect(await tick(ports)).toBe("manual");
  expect(calls.filter((x) => x === "off")).toHaveLength(1);
  expect(calls.filter((x) => x === "resume-proof-only")).toHaveLength(1);
});
test("unproven resumed drain remains held without replay", async () => {
  const { ports, calls } = fixture();
  ports.off = async () => {
    calls.push("off");
    throw Error("unknown");
  };
  ports.resumeOff = async () => {
    throw Error("no current matching drain");
  };
  expect(await tick(ports)).toBe("held");
  expect(await tick(ports)).toBe("held");
  expect(calls.filter((x) => x === "off")).toHaveLength(1);
});
test("binding or indeterminate claim failure never reaches OFF", async () => {
  for (const target of ["verifyBinding", "claim"] as const) {
    const { ports, calls } = fixture();
    ports[target] = async () => {
      throw Error("indeterminate");
    };
    await expect(tick(ports)).rejects.toThrow("indeterminate");
    expect(calls).not.toContain("off");
  }
});
test("concurrent ticks share the durable claim contract; only winner invokes OFF", async () => {
  const { ports, calls } = fixture();
  expect((await Promise.all([tick(ports), tick(ports)])).sort()).toEqual(["held", "manual"]);
  expect(calls.filter((x) => x === "off")).toHaveLength(1);
});
test("unreachable status attempts proven OFF, not assumed Manual", async () => {
  const { ports, calls } = fixture();
  ports.status = async () => {
    throw Error("unreachable");
  };
  ports.off = async () => {
    calls.push("off");
    throw Error("no drain witness");
  };
  expect(await tick(ports)).toBe("held");
  expect(calls).not.toContain("manual");
});
