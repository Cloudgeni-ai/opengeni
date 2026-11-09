import { expect, test } from "bun:test";
import type { ChatClient, ChatSession, Session } from "@opengeni/sdk";
import type {
  OpenGeniNativeSessionClient,
  OpenGeniNativeSessionController,
} from "../src/use-native-session";

function responseContracts(
  full: OpenGeniNativeSessionClient,
  compact: OpenGeniNativeSessionClient<ChatClient>,
  controller: OpenGeniNativeSessionController,
  compactController: OpenGeniNativeSessionController<ChatClient>,
) {
  const fullRead: Promise<Session> = full.getSession("workspace", "session");
  const compactRead: Promise<ChatSession> = compact.getSession("workspace", "session");
  const fullSession: Session | null = controller.session.session;
  const compactSession: ChatSession | null = compactController.session.session;
  // @ts-expect-error A compact controller does not promise operator configuration.
  const notFull: Session | null = compactController.session.session;
  return { fullRead, compactRead, fullSession, compactSession, notFull };
}

test("native controller and client aliases preserve full defaults with explicit compact types", () => {
  expect(typeof responseContracts).toBe("function");
});
