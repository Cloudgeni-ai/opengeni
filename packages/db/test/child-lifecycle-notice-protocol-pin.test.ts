import { expect, test } from "bun:test";
import { CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION } from "@opengeni/contracts";
import {
  CHILD_LIFECYCLE_DEDUPE_PREFIX,
  childPausedDedupeKey,
  childProgressDedupeKey,
  childRequiresActionDedupeKey,
  childRequiresActionResolvedDedupeKey,
  childWaitingCapacityDedupeKey,
} from "../src/child-lifecycle-notices";

test("producer-side notice keys are pinned to the notice protocol revision", () => {
  // Older consumers deduplicate and supersede notices by these keys, which the
  // committed protocol rendering cannot see. Changing them changes the notice
  // protocol: bump CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION, regenerate
  // child-lifecycle-notice-protocol.gen.json, then update this pin.
  const child = "00000000-0000-4000-8000-000000000001";
  expect({
    revision: CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION,
    prefixes: CHILD_LIFECYCLE_DEDUPE_PREFIX,
    keys: [
      childRequiresActionDedupeKey({ childSessionId: child, turnId: "t", turnGeneration: 2 }),
      childRequiresActionResolvedDedupeKey({
        childSessionId: child,
        turnId: "t",
        turnGeneration: 2,
        requestId: null,
        approvalId: "a",
      }),
      childPausedDedupeKey({ childSessionId: child, receiptId: "r" }),
      childWaitingCapacityDedupeKey({ childSessionId: child, waiterId: "w" }),
      childProgressDedupeKey({ childSessionId: child, receiptId: "r" }),
    ],
  }).toEqual({
    revision: 1,
    prefixes: {
      requiresAction: "child-requires-action",
      requiresActionResolved: "child-requires-action-resolved",
      paused: "child-paused",
      waitingCapacity: "child-waiting-capacity",
      progress: "child-progress",
    },
    keys: [
      `child-requires-action:${child}:t:2`,
      `child-requires-action-resolved:${child}:t:2:a`,
      `child-paused:${child}:r`,
      `child-waiting-capacity:${child}:w`,
      `child-progress:${child}:r`,
    ],
  });
});
