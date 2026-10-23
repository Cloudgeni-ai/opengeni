import { expect, test } from "bun:test";
import { NoWorkspaceError, startProblem } from "../src/lib/start-error";

const withStatus = (status: number) => Object.assign(new Error("raw server text"), { status });

test("an expired sign-in asks to sign in again", () => {
  expect(startProblem(withStatus(401))).toMatchObject({ title: "Sign in again", signIn: true });
  // A refusal is not an expired sign-in: signing out would loop.
  expect(startProblem(withStatus(403))).toMatchObject({ signIn: false, otherAccount: true });
});

test("a network failure says Opengeni can't be reached", () => {
  expect(startProblem(new TypeError("Failed to fetch"))).toMatchObject({
    title: "Opengeni can't be reached",
    signIn: false,
  });
});

test("a server failure never shows the raw text", () => {
  const problem = startProblem(withStatus(500));
  expect(problem.signIn).toBe(false);
  expect(problem.message).not.toContain("raw server text");
});

test("an account without a workspace can sign in as someone else", () => {
  expect(startProblem(new NoWorkspaceError())).toMatchObject({ signIn: true });
});
