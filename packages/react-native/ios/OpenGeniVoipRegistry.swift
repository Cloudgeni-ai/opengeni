import Foundation
import PushKit

/// PushKit for agent calls. iOS wakes (or launches) the app for each VoIP push,
/// and the app must report it to CallKit before the handler returns, so this
/// runs natively from launch, before JavaScript exists.
final class OpenGeniVoipRegistry: NSObject, PKPushRegistryDelegate {
  static let shared = OpenGeniVoipRegistry()

  private var registry: PKPushRegistry?

  /// Register for VoIP pushes. Safe to call more than once.
  func start() {
    guard registry == nil else { return }
    let created = PKPushRegistry(queue: .main)
    created.delegate = self
    created.desiredPushTypes = [.voIP]
    registry = created
  }

  func pushRegistry(
    _ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType
  ) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    OpenGeniCallCenter.shared.updateVoipToken(token)
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    OpenGeniCallCenter.shared.updateVoipToken(nil)
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else { return completion() }
    let call = payload.dictionaryPayload["call"] as? [String: Any] ?? [:]
    OpenGeniCallCenter.shared.reportIncoming(call, completion: completion)
  }
}
