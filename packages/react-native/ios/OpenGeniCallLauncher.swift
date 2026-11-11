import Foundation

/// The app-facing entry for starting a call from outside JavaScript, used by the
/// App Intent the config plugin generates in the app target. Requests queue
/// until JavaScript observes them, exactly like Phone recents and the
/// home-screen action.
public enum OpenGeniCallLauncher {
  /// Ask JavaScript to start a call. `target` is a session id, or nil to let the
  /// host choose (for example the session the user last had open).
  public static func requestStart(target: String? = nil) {
    OpenGeniCallCenter.shared.requestStart(target: target)
  }
}
