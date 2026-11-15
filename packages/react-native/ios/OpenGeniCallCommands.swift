import Foundation

/// A spoken command the person made in the app for one chat: saying its name
/// to Siri ("Call Research in <app>") starts a call straight into that chat.
public struct OpenGeniCallCommand: Codable, Equatable, Sendable {
  public let id: String
  public let workspaceId: String
  public let sessionId: String
  /// The name the person says.
  public let name: String
  /// Other names Siri accepts for it.
  public let synonyms: [String]

  init?(_ raw: [String: Any]) {
    func text(_ key: String) -> String? {
      guard let value = (raw[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
        !value.isEmpty
      else { return nil }
      return value
    }
    guard let id = text("id"), let workspaceId = text("workspaceId"),
      let sessionId = text("sessionId"), let name = text("name")
    else { return nil }
    self.id = id
    self.workspaceId = workspaceId
    self.sessionId = sessionId
    self.name = name
    synonyms = ((raw["synonyms"] as? [Any]) ?? []).compactMap {
      ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }
  }
}

/// The voice commands Siri and the Shortcuts app offer. The app writes the
/// signed-in account's commands here (and none while signed out); the App
/// Intent the config plugin generates reads them in the app's own process.
enum OpenGeniCallCommands {
  private static let key = "dev.opengeni.call.commands.v1"

  static func all() -> [OpenGeniCallCommand] {
    guard let data = UserDefaults.standard.data(forKey: key),
      let commands = try? JSONDecoder().decode([OpenGeniCallCommand].self, from: data)
    else { return [] }
    return commands
  }

  static func command(id: String) -> OpenGeniCallCommand? {
    all().first { $0.id == id }
  }

  /// Replace the commands and have Siri read them again.
  static func replace(_ commands: [OpenGeniCallCommand]) {
    if commands.isEmpty {
      UserDefaults.standard.removeObject(forKey: key)
    } else if let data = try? JSONEncoder().encode(commands) {
      UserDefaults.standard.set(data, forKey: key)
    }
    refreshShortcuts()
  }

  /// Ask Siri to read the app's shortcut parameters again, through the class the
  /// config plugin generates in the app target. Without the generated intent
  /// (`call.appIntents: false`) there is nothing to refresh.
  static func refreshShortcuts() {
    let selector = NSSelectorFromString("refresh")
    guard let refresher = NSClassFromString("OpenGeniCallShortcutsRefresher") as? NSObject.Type,
      refresher.responds(to: selector)
    else { return }
    _ = refresher.perform(selector)
  }
}
