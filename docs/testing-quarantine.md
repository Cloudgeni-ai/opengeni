# Quarantined tests

A quarantined test is a known-flaky test that still runs in every lane (PR,
batch and main CI, and locally) but whose failure does not fail the lane. Its
failure is still reported: the full error goes to the log, a
`Quarantined test failed` warning annotation appears on the run, and a line is
added to the job's step summary with the tracking issue.

Quarantine is for tests whose fix is not yet clear. When the cause is clear
and contained (a race, a timeout, an ordering assumption), fix it instead.

## The list

[`packages/testing/quarantine.json`](../packages/testing/quarantine.json) is
the only place that decides what is quarantined. Each entry has:

- `file`: the repository-relative test file;
- `test`: the test's own title, as passed to `test()`, without `describe()`
  prefixes. For a title built from a template, list the concrete title, so
  only that case is quarantined;
- `issue`: the public GitHub issue in this repository that tracks the fix;
- `reason`: what fails, in a sentence;
- `added`: the day (`YYYY-MM-DD`, UTC) the entry was added or last renewed;
- `expires`: the last day the quarantine holds, at most 30 days after `added`.

`packages/testing/test/quarantine.test.ts` checks that every entry still points
at an existing test registered through `quarantineTest`, has a tracking issue,
is listed once, and ends at most 30 days after it was added.

## Expiry

A quarantine always ends. From the day after `expires`, the test fails
normally again, and the run gets a `Test quarantine expired` warning. The list
check itself never fails because a date has passed, so an expired entry fails
only its own test, not unrelated work.

To renew, after checking that the issue is still being worked on, set `added`
to today and `expires` to at most 30 days later in a pull request labelled
`test-policy-change`, and note the renewal on the issue. If the issue is
closed, the test is fixed: remove the entry instead.

## Quarantining a test

1. Open or find the tracking issue.
2. Add the entry to `quarantine.json`.
3. In the test file, rebind `test` through `quarantineTest`. Call sites stay
   unchanged:

   ```ts
   import { test as bunTest } from "bun:test";
   import { quarantineTest } from "@opengeni/testing/quarantine";

   const test = quarantineTest(bunTest, import.meta.path);
   ```

   `quarantineTest` also wraps conditional aliases such as
   `enabled ? test : test.skip`. Every call that the list does not name goes
   straight to the original `test`, and `test.skip`, `test.each` and the rest
   are unchanged.

4. Label the pull request `test-policy-change`.

Only failures thrown by the test body are absorbed; a failing hook still fails
the run. A test that can hang needs `{ deadlineMs }` (the third argument of
`quarantineTest`) below its own timeout, so the hang is reported rather than
failing as a timeout. The hung work is abandoned, not cancelled.

## Fixing a quarantined test

Run it with `OPENGENI_TEST_QUARANTINE=enforce` to make its failures fail again.
When the fix lands, remove the entry (and the `quarantineTest` rebinding if no
other entry uses it) in the same pull request, and close the issue.
