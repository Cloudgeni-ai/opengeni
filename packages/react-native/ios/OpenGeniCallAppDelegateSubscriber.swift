import ExpoModulesCore
import Intents
import UIKit

/// Turns system call launches into start requests: a call from the Phone
/// app's recents or Siri (INStartCallIntent), and the home-screen quick action
/// whose type ends in ".call". Registers for agent calls (PushKit) at launch,
/// since iOS may launch the app in the background just to ring one.
///
/// Only the phone's owner may reach the agent: a system call request that
/// arrives while the phone is locked (Siri, or a recent in CarPlay, can launch
/// the app without unlocking it) waits for the phone to be unlocked, and is
/// dropped if that does not happen soon after. App Intents ask for the unlock
/// themselves (their authentication policy).
public class OpenGeniCallAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  /// How long a request made while locked waits for the unlock.
  private static let unlockWindow: TimeInterval = 30
  private var lockedRequest: (handle: String?, at: Date)?
  private var unlockObserver: NSObjectProtocol?

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    OpenGeniVoipRegistry.shared.start()
    // Siri reads the voice commands again after an app update or restore.
    DispatchQueue.main.async { OpenGeniCallCommands.refreshShortcuts() }
    return true
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard let intent = userActivity.interaction?.intent as? INStartCallIntent else { return false }
    let handle = intent.contacts?.first?.personHandle?.value
    if application.isProtectedDataAvailable {
      OpenGeniCallCenter.shared.requestStart(handle: handle)
    } else {
      startWhenUnlocked(handle)
    }
    return true
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard shortcutItem.type.hasSuffix(".call") else { return completionHandler(false) }
    // The home screen is only reachable unlocked.
    OpenGeniCallCenter.shared.requestStart(
      target: shortcutItem.userInfo?["target"] as? String,
      workspaceId: shortcutItem.userInfo?["workspaceId"] as? String)
    completionHandler(true)
  }

  /// Keep the request until the phone is unlocked; a later unlock does not
  /// start a call nobody is waiting for any more.
  private func startWhenUnlocked(_ handle: String?) {
    lockedRequest = (handle, Date())
    guard unlockObserver == nil else { return }
    unlockObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      if let observer = self.unlockObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      self.unlockObserver = nil
      guard let request = self.lockedRequest else { return }
      self.lockedRequest = nil
      if Date().timeIntervalSince(request.at) <= Self.unlockWindow {
        OpenGeniCallCenter.shared.requestStart(handle: request.handle)
      }
    }
  }
}
