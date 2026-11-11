// Pure parts of the native call config plugin (no Expo imports), so they are
// testable on their own: option defaults and the generated App Intent source.
const SWIFT_FILE = "OpenGeniCallIntents.swift";
const APP_NAME_TOKEN = "{app}";
const CHAT_TOKEN = "{chat}";
const DEFAULTS = {
  title: "Start a call",
  description: "Start a voice call with your agent.",
  shortTitle: "Call",
  systemImage: "phone.fill",
  phrases: ["Call {app}", "Start a call with {app}", "Talk to {app}"],
  // Voice commands: the person picks chats in the app, and each gets these
  // phrases with its spoken name ("Call Research in Opengeni").
  chatPhrases: ["Call {chat} in {app}", "Talk to {chat} in {app}"],
  chatShortTitle: "Call a chat",
  chatTitle: "Chat",
  chatSummary: "Call {chat}",
  chatMissing: "That voice command no longer exists. Open the app to set it up again.",
  microphonePermission: "Talk to your agent on voice calls.",
};

function swiftString(value) {
  return JSON.stringify(String(value)).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
}

function occurrences(text, token) {
  return String(text).split(token).length - 1;
}

/** Text between interpolations, escaped for a Swift string literal. */
function swiftLiteralPart(text) {
  return swiftString(text).slice(1, -1);
}

/** A phrase literal: `{app}` becomes the app-name interpolation Siri requires. */
function swiftPhrase(phrase) {
  if (occurrences(phrase, APP_NAME_TOKEN) !== 1 || occurrences(phrase, CHAT_TOKEN) !== 0) {
    throw new Error(
      `@opengeni/react-native: every call phrase must contain ${APP_NAME_TOKEN} exactly once and no ${CHAT_TOKEN} (got "${phrase}").`,
    );
  }
  const [before, after] = String(phrase).split(APP_NAME_TOKEN).map(swiftLiteralPart);
  return `"${before}\\(.applicationName)${after}"`;
}

/**
 * A voice-command phrase literal: `{chat}` becomes the chat parameter and
 * `{app}` the app name, each exactly once, in either order.
 */
function swiftChatPhrase(phrase) {
  const text = String(phrase);
  if (occurrences(text, APP_NAME_TOKEN) !== 1 || occurrences(text, CHAT_TOKEN) !== 1) {
    throw new Error(
      `@opengeni/react-native: every chat phrase must contain ${CHAT_TOKEN} and ${APP_NAME_TOKEN} exactly once each (got "${phrase}").`,
    );
  }
  return `"${text
    .split(/(\{app\}|\{chat\})/)
    .map((part) =>
      part === APP_NAME_TOKEN
        ? "\\(.applicationName)"
        : part === CHAT_TOKEN
          ? "\\(\\.$chat)"
          : swiftLiteralPart(part),
    )
    .join("")}"`;
}

/** The parameter summary: `{chat}` (once) becomes the chat parameter. */
function swiftChatSummary(summary) {
  const text = String(summary);
  if (occurrences(text, CHAT_TOKEN) !== 1 || occurrences(text, APP_NAME_TOKEN) !== 0) {
    throw new Error(
      `@opengeni/react-native: call.chatSummary must contain ${CHAT_TOKEN} exactly once and no ${APP_NAME_TOKEN} (got "${summary}").`,
    );
  }
  const [before, after] = text.split(CHAT_TOKEN).map(swiftLiteralPart);
  return `"${before}\\(\\.$chat)${after}"`;
}

/**
 * The chat entity and the start-call intent. The app target gets the working
 * copy: its query reads the voice commands the app stored natively, and its
 * intent starts the call. The control extension (`catalog: false`) declares the
 * same types so its button can run the intent, but never performs it: with
 * `openAppWhenRun` the system opens the app and runs the app's copy.
 */
function callIntentDeclarations(call, { catalog }) {
  const commands = catalog
    ? `OpenGeniCallLauncher.commands().map(OpenGeniCallChatEntity.init)`
    : "[OpenGeniCallChatEntity]()";
  const perform = catalog
    ? `  @MainActor
  func perform() async throws -> some IntentResult {
    guard let chat else {
      OpenGeniCallLauncher.requestStart()
      return .result()
    }
    // Only a command the signed-in person has now: a removed one, or one of an
    // account that signed out, never falls back to another call.
    guard let command = OpenGeniCallLauncher.command(id: chat.id) else {
      throw OpenGeniCallChatMissing()
    }
    OpenGeniCallLauncher.requestStart(target: command.sessionId, workspaceId: command.workspaceId)
    return .result()
  }`
    : `  func perform() async throws -> some IntentResult {
    return .result()
  }`;
  return `/// A chat the person gave a voice command in the app. Its title is the name
/// they say ("Call Research in ..."); only chats they chose are listed.
@available(iOS 16.0, *)
struct OpenGeniCallChatEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: ${swiftString(call.chatTitle)})
  static let defaultQuery = OpenGeniCallChatQuery()

  let id: String
  let name: String
  let synonyms: [String]

  var displayRepresentation: DisplayRepresentation {
    let title = LocalizedStringResource(stringLiteral: name)
    if #available(iOS 17.0, *) {
      return DisplayRepresentation(
        title: title, synonyms: synonyms.map { LocalizedStringResource(stringLiteral: $0) })
    }
    return DisplayRepresentation(title: title)
  }
${
  catalog
    ? `
  init(_ command: OpenGeniCallCommand) {
    id = command.id
    name = command.name
    synonyms = command.synonyms
  }
`
    : ""
}}

@available(iOS 16.0, *)
struct OpenGeniCallChatQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [OpenGeniCallChatEntity] {
    let commands = ${commands}
    return identifiers.compactMap { id in commands.first { $0.id == id } }
  }

  func entities(matching string: String) async throws -> [OpenGeniCallChatEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return ${commands}.filter { chat in
      ([chat.name] + chat.synonyms).contains { $0.localizedCaseInsensitiveContains(query) }
    }
  }

  func suggestedEntities() async throws -> [OpenGeniCallChatEntity] {
    ${commands}
  }
}

@available(iOS 16.0, *)
struct OpenGeniCallChatMissing: Error, CustomLocalizedStringResourceConvertible {
  var localizedStringResource: LocalizedStringResource { ${swiftString(call.chatMissing)} }
}

/// Starts a call: with a chat, straight into that chat; without one, wherever
/// the app sends calls from outside. Only the phone's owner, unlocked, can run
/// it: a locked phone asks to be unlocked first.
@available(iOS 16.0, *)
struct OpenGeniStartCallIntent: AppIntent {
  static let title: LocalizedStringResource = ${swiftString(call.title)}
  static let description = IntentDescription(${swiftString(call.description)})
  static let openAppWhenRun: Bool = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: ${swiftString(call.chatTitle)})
  var chat: OpenGeniCallChatEntity?

  static var parameterSummary: some ParameterSummary {
    Summary(${swiftChatSummary(call.chatSummary)})
  }

${perform}
}`;
}

function intentsSource(call) {
  const phrases = call.phrases.map(swiftPhrase).join(",\n        ");
  const chatPhrases = call.chatPhrases.map(swiftChatPhrase).join(",\n        ");
  const chatShortcut =
    call.chatPhrases.length > 0
      ? `
    AppShortcut(
      intent: OpenGeniStartCallIntent(),
      phrases: [
        ${chatPhrases}
      ],
      shortTitle: ${swiftString(call.chatShortTitle)},
      systemImageName: ${swiftString(call.systemImage)}
    )`
      : "";
  return `// Generated by the @opengeni/react-native config plugin. Do not edit.
import AppIntents
import Foundation
internal import OpenGeniCall

${callIntentDeclarations(call, { catalog: true })}

@available(iOS 16.0, *)
struct OpenGeniCallShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenGeniStartCallIntent(),
      phrases: [
        ${phrases}
      ],
      shortTitle: ${swiftString(call.shortTitle)},
      systemImageName: ${swiftString(call.systemImage)}
    )${chatShortcut}
  }
}

/// The call module stores the voice commands and asks Siri to read them again
/// through this class, found by name: the shortcuts provider lives here, in
/// the app target, which the module cannot link to.
@objc(OpenGeniCallShortcutsRefresher)
final class OpenGeniCallShortcutsRefresher: NSObject {
  @objc static func refresh() {
    if #available(iOS 16.0, *) {
      OpenGeniCallShortcuts.updateAppShortcutParameters()
    }
  }
}
`;
}

function resolveOptions(props = {}) {
  const call = { ...DEFAULTS, ...(props.call ?? {}) };
  if (!Array.isArray(call.phrases) || call.phrases.length === 0) {
    throw new Error("@opengeni/react-native: call.phrases must list at least one phrase.");
  }
  call.phrases.forEach(swiftPhrase);
  if (!Array.isArray(call.chatPhrases)) {
    throw new Error("@opengeni/react-native: call.chatPhrases must be a list (it may be empty).");
  }
  call.chatPhrases.forEach(swiftChatPhrase);
  swiftChatSummary(call.chatSummary);
  return {
    call,
    alternativeAppNames: call.alternativeAppNames ?? [],
    microphonePermission: props.microphonePermission ?? DEFAULTS.microphonePermission,
    appIntents: call.appIntents !== false,
    iosAudioDevice: call.iosAudioDevice === true,
  };
}

/**
 * What the plugin sets up: calls when `call` is given (and is not false) or
 * when nothing else is asked for, so the bare plugin keeps meaning calls;
 * recording when `recording` is true. A meetings-only app passes just
 * `recording: true` and gets no VoIP background mode or Siri intents.
 */
function pluginFeatures(props = {}) {
  const recording = props?.recording === true;
  const audioImport = props?.audioImport === true;
  // Calls stay the default only for the plugin used without any feature.
  const call =
    props?.call === false ? false : props?.call !== undefined || (!recording && !audioImport);
  return { call, recording, audioImport };
}

module.exports = {
  SWIFT_FILE,
  callIntentDeclarations,
  intentsSource,
  pluginFeatures,
  resolveOptions,
};
