import { describe, expect, test } from "bun:test";
import { sessionAuthorizationOperationForHttp } from "../src/routes/sessions";
import type { SessionAuthorizationOperation } from "@opengeni/contracts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const root = `/v1/workspaces/22222222-2222-4222-8222-222222222222/sessions/${sessionId}`;

const cases: Array<[string, string, SessionAuthorizationOperation]> = [
  ["GET", "", "session.read"],
  ["PATCH", "", "session.title.write"],
  ["PUT", "/pin", "session.pin.write"],
  ["GET", "/lineage", "session.lineage.read"],
  ["POST", "/codex-account", "session.codex_account.write"],
  ["GET", "/goal", "session.goal.read"],
  ["PATCH", "/goal", "session.goal.write"],
  ["DELETE", "/goal", "session.goal.write"],
  ["POST", "/context/clear", "session.context.write"],
  ["POST", "/context/compact", "session.context.write"],
  ["GET", "/events", "session.events.read"],
  ["POST", "/events", "session.append"],
  ["GET", "/events/stream", "session.stream.read"],
  ["GET", "/turns", "session.turns.read"],
  ["GET", "/queue", "session.queue.read"],
  ["POST", "/queue/33333333-3333-4333-8333-333333333333/move", "session.queue.control"],
  ["POST", "/queue/33333333-3333-4333-8333-333333333333/edit", "session.queue.control"],
  ["POST", "/queue/33333333-3333-4333-8333-333333333333/steer", "session.queue.control"],
  ["POST", "/queue/33333333-3333-4333-8333-333333333333/delete", "session.queue.control"],
  ["GET", "/composer-draft", "session.composer.read"],
  ["PUT", "/composer-draft", "session.composer.write"],
  ["POST", "/control", "session.control"],
  ["POST", "/steer", "session.steer"],
  ["GET", "/human-input-requests", "session.human_input.read"],
  ["GET", "/human-input-requests/44444444-4444-4444-8444-444444444444", "session.human_input.read"],
  ["GET", "/stream-capabilities", "session.viewer.read"],
  ["POST", "/stream-capabilities/acknowledge", "session.stream.acknowledge"],
  ["POST", "/viewers", "session.viewer.control"],
  ["POST", "/viewers/viewer/heartbeat", "session.viewer.control"],
  ["DELETE", "/viewers/viewer", "session.viewer.control"],
  ["POST", "/viewers/viewer/revoke", "session.viewer.control"],
  ["POST", "/fs/list", "session.files.read"],
  ["POST", "/fs/read", "session.files.read"],
  ["POST", "/fs/write", "session.files.write"],
  ["POST", "/fs/delete", "session.files.write"],
  ["POST", "/fs/move", "session.files.write"],
  ["POST", "/fs/mkdir", "session.files.write"],
  ["POST", "/git/status", "session.git.read"],
  ["POST", "/git/diff", "session.git.read"],
  ["POST", "/git/log", "session.git.read"],
  ["POST", "/git/show", "session.git.read"],
  ["GET", "/workspace/capture", "session.capture.read"],
  ["GET", "/workspace/capture/file", "session.capture.read"],
  ["POST", "/terminal/exec", "session.terminal.control"],
  ["POST", "/terminal/pty", "session.terminal.control"],
  ["POST", "/terminal/pty/write", "session.terminal.control"],
  ["POST", "/terminal/pty/resize", "session.terminal.control"],
  ["POST", "/terminal/pty/close", "session.terminal.control"],
];

describe("session HTTP authorization classification", () => {
  test.each(cases)("%s %s maps to %s", (method, suffix, expected) => {
    expect(sessionAuthorizationOperationForHttp(method, `${root}${suffix}`, sessionId)).toBe(
      expected,
    );
  });

  test("unknown or wrong-method surfaces fail closed", () => {
    expect(sessionAuthorizationOperationForHttp("POST", `${root}/future-surface`, sessionId)).toBe(
      null,
    );
    expect(sessionAuthorizationOperationForHttp("DELETE", `${root}/events`, sessionId)).toBe(null);
  });
});
