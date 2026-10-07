import AVFoundation
import CallKit
import Foundation

/// One CallKit provider for the process. The app delegate subscriber can receive
/// a start request (Siri, Phone recents, a home-screen action) before the module
/// or JavaScript exists, so requests wait here until JavaScript observes them.
final class OpenGeniCallCenter: NSObject, CXProviderDelegate {
  static let shared = OpenGeniCallCenter()

  private let controller = CXCallController()
  private var provider: CXProvider?
  private var activeCalls = Set<UUID>()
  private var pendingStart: [String: Any]?
  private var routeObserver: NSObjectProtocol?
  private var speaker = true

  /// Set while JavaScript observes events; nil otherwise.
  var emit: (([String: Any]) -> Void)? {
    didSet {
      if emit != nil, let pending = pendingStart {
        pendingStart = nil
        emit?(pending)
      }
    }
  }

  func configure(includeInRecents: Bool) {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = includeInRecents
    if let provider {
      provider.configuration = configuration
      return
    }
    let created = CXProvider(configuration: configuration)
    created.setDelegate(self, queue: nil)
    provider = created
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.send(["type": "routeChanged", "route": Self.currentRoute()])
    }
  }

  // MARK: Requests from JavaScript

  func startCall(id: UUID, title: String, target: String?, completion: @escaping (Error?) -> Void) {
    if provider == nil { configure(includeInRecents: true) }
    let handle = CXHandle(type: .generic, value: target ?? "opengeni")
    let action = CXStartCallAction(call: id, handle: handle)
    action.contactIdentifier = title
    controller.request(CXTransaction(action: action)) { [weak self] error in
      DispatchQueue.main.async {
        if error == nil {
          self?.activeCalls.insert(id)
          let update = CXCallUpdate()
          update.remoteHandle = handle
          update.localizedCallerName = title
          update.hasVideo = false
          update.supportsHolding = false
          update.supportsGrouping = false
          update.supportsUngrouping = false
          update.supportsDTMF = false
          self?.provider?.reportCall(with: id, updated: update)
        }
        completion(error)
      }
    }
  }

  func reportConnected(id: UUID) {
    provider?.reportOutgoingCall(with: id, connectedAt: Date())
  }

  func endCall(id: UUID, failed: Bool, completion: @escaping () -> Void) {
    guard activeCalls.contains(id) else { return completion() }
    if failed {
      activeCalls.remove(id)
      provider?.reportCall(with: id, endedAt: Date(), reason: .failed)
      return completion()
    }
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
      DispatchQueue.main.async {
        if error != nil {
          self?.activeCalls.remove(id)
          self?.provider?.reportCall(with: id, endedAt: Date(), reason: .remoteEnded)
        }
        completion()
      }
    }
  }

  func setMuted(id: UUID, muted: Bool, completion: @escaping () -> Void) {
    guard activeCalls.contains(id) else { return completion() }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { _ in
      DispatchQueue.main.async { completion() }
    }
  }

  func setSpeaker(_ on: Bool) throws {
    speaker = on
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: Self.options(speaker: on))
    try session.overrideOutputAudioPort(on ? .speaker : .none)
  }

  // MARK: Start requests from outside the app

  func requestStart(target: String?) {
    let event: [String: Any] = ["type": "startRequested", "target": target ?? NSNull()]
    if let emit {
      emit(event)
    } else {
      pendingStart = event
    }
  }

  func takePendingStart() -> [String: Any]? {
    defer { pendingStart = nil }
    guard let pending = pendingStart else { return nil }
    return ["target": pending["target"] ?? NSNull()]
  }

  // MARK: CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    for id in activeCalls { send(["type": "ended", "callId": id.uuidString.lowercased()]) }
    activeCalls.removeAll()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // CallKit activates this configuration; WebRTC's voice processing then
    // provides echo cancellation for hands-free use.
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playAndRecord, mode: .voiceChat, options: Self.options(speaker: speaker))
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    activeCalls.remove(action.callUUID)
    send(["type": "ended", "callId": action.callUUID.uuidString.lowercased()])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    send([
      "type": "muteChanged", "callId": action.callUUID.uuidString.lowercased(),
      "muted": action.isMuted,
    ])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    send(["type": "audioSessionActivated"])
    send(["type": "routeChanged", "route": Self.currentRoute()])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    send(["type": "audioSessionDeactivated"])
  }

  // MARK: Helpers

  private func send(_ event: [String: Any]) {
    DispatchQueue.main.async { [weak self] in self?.emit?(event) }
  }

  private static func options(speaker: Bool) -> AVAudioSession.CategoryOptions {
    speaker ? [.allowBluetooth, .defaultToSpeaker] : [.allowBluetooth]
  }

  static func currentRoute() -> String {
    guard let output = AVAudioSession.sharedInstance().currentRoute.outputs.first else {
      return "other"
    }
    switch output.portType {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "receiver"
    case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .carAudio: return "bluetooth"
    case .headphones, .usbAudio: return "headphones"
    default: return "other"
    }
  }
}
