import ExpoModulesCore
import Intents
import UIKit

/// Turns system call launches into start requests: a call from the Phone
/// app's recents or Siri (INStartCallIntent), and the home-screen quick action
/// whose type ends in ".call". Registers for agent calls (PushKit) at launch,
/// since iOS may launch the app in the background just to ring one.
public class OpenGeniCallAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    OpenGeniVoipRegistry.shared.start()
    return true
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard let intent = userActivity.interaction?.intent as? INStartCallIntent else { return false }
    let target = intent.contacts?.first?.personHandle?.value
    OpenGeniCallCenter.shared.requestStart(target: target == "opengeni" ? nil : target)
    return true
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard shortcutItem.type.hasSuffix(".call") else { return completionHandler(false) }
    OpenGeniCallCenter.shared.requestStart(target: shortcutItem.userInfo?["target"] as? String)
    completionHandler(true)
  }
}
