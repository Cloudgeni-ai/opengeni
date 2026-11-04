import AVFoundation
import CallKit
import Foundation

/// One CallKit provider for the process. The app delegate subscriber can receive
/// a start request (Siri, Phone recents, a home-screen action) before the module
/// or JavaScript exists, so requests wait here until JavaScript observes them.
/// Incoming agent calls (PushKit) are reported here too, and kept until
/// JavaScript takes them: a push can launch the app straight into a ringing call.
final class OpenGeniCallCenter: NSObject, CXProviderDelegate {
  static let shared = OpenGeniCallCenter()

  /// An agent's call to this phone, from its ring to its answer.
  struct IncomingCall {
    var id: UUID
    var sessionId: String
    var workspaceId: String
    var subjectId: String?
    var title: String?
    var reason: String?
    var ringUntil: Date?
    /// "ringing", then "answered" or "declined" by the person on this phone.
    var state: String
    /// Whether JavaScript has seen this call in its current state.
    var delivered = false

    func event(_ type: String) -> [String: Any] {
      var event: [String: Any] = [
        "type": type,
        "callId": id.uuidString.lowercased(),
        "sessionId": sessionId,
        "workspaceId": workspaceId,
        "state": state,
      ]
      if let subjectId { event["subjectId"] = subjectId }
      if let title { event["title"] = title }
      if let reason { event["reason"] = reason }
      if let ringUntil { event["ringUntil"] = ISO8601DateFormatter().string(from: ringUntil) }
      return event
    }
  }

  private let controller = CXCallController()
  private var provider: CXProvider?
  private var activeCalls = Set<UUID>()
  private var incoming: [UUID: IncomingCall] = [:]
  private var pendingStart: [String: Any]?
  private var routeObserver: NSObjectProtocol?
  private var speaker = true
  private(set) var voipToken: String?

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
    // The Simulator accepts a call, then ends it at once: CallKit does not run
    // there. Refuse it, so the call continues in the app without the system UI.
    guard Self.callKitRuns else {
      return completion(
        NSError(
          domain: "OpenGeniCall", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "CallKit does not run in the Simulator."]))
    }
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
    // An answered incoming call is connected from the moment it was answered.
    if incoming[id] != nil { return }
    provider?.reportOutgoingCall(with: id, connectedAt: Date())
  }

  func endCall(id: UUID, failed: Bool, completion: @escaping () -> Void) {
    incoming.removeValue(forKey: id)
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

  // MARK: Incoming agent calls

  func updateVoipToken(_ token: String?) {
    voipToken = token
    send(["type": "voipToken", "token": token ?? NSNull()])
  }

  /// Report a VoIP push to CallKit at once, as iOS requires for every one. A
  /// push that arrives after its ring ended still rings, and ends at once.
  func reportIncoming(_ payload: [String: Any], completion: @escaping () -> Void) {
    if provider == nil { configure(includeInRecents: true) }
    guard let provider else { return completion() }
    let id = (payload["callId"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
    let sessionId = payload["sessionId"] as? String ?? ""
    let ringUntil = (payload["ringUntil"] as? String).flatMap(Self.parseDate)
    let call = IncomingCall(
      id: id,
      sessionId: sessionId,
      workspaceId: payload["workspaceId"] as? String ?? "",
      subjectId: payload["subjectId"] as? String,
      title: Self.nonEmpty(payload["title"] as? String),
      reason: Self.nonEmpty(payload["reason"] as? String),
      ringUntil: ringUntil,
      state: "ringing")
    let update = CXCallUpdate()
    // Calling back from the Phone app's recents returns to the same chat.
    update.remoteHandle = CXHandle(type: .generic, value: sessionId.isEmpty ? "opengeni" : sessionId)
    // The ring screen says why the agent calls; the app name shows beneath it.
    update.localizedCallerName = call.reason ?? call.title ?? "Your agent"
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    let valid = !sessionId.isEmpty && !call.workspaceId.isEmpty
    provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
      DispatchQueue.main.async {
        defer { completion() }
        // Focus, Do Not Disturb, another call: iOS did not ring it.
        guard error == nil, let self else { return }
        let remaining = ringUntil.map { $0.timeIntervalSinceNow } ?? 40
        guard valid, remaining > 0 else {
          provider.reportCall(with: id, endedAt: Date(), reason: .unanswered)
          return
        }
        self.incoming[id] = call
        self.deliver(id, "incoming")
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining + 1) { [weak self] in
          guard let self, self.incoming[id]?.state == "ringing" else { return }
          self.incoming.removeValue(forKey: id)
          self.provider?.reportCall(with: id, endedAt: Date(), reason: .unanswered)
          self.send(["type": "incomingEnded", "callId": id.uuidString.lowercased(), "reason": "unanswered"])
        }
      }
    }
  }

  /// End a ringing call that was settled on another phone, rang out, or failed.
  func endIncoming(id: UUID, reason: String) {
    guard let call = incoming[id] else { return }
    incoming.removeValue(forKey: id)
    let ended: CXCallEndedReason =
      switch reason {
      case "answeredElsewhere": .answeredElsewhere
      case "declinedElsewhere": .declinedElsewhere
      case "unanswered": .unanswered
      case "failed": .failed
      default: .remoteEnded
      }
    if call.state == "answered" { activeCalls.remove(id) }
    provider?.reportCall(with: id, endedAt: Date(), reason: ended)
  }

  /// Calls JavaScript should act on: every ringing call (watching one twice is
  /// harmless), and each answer or decline it has not seen yet, exactly once,
  /// so a remounted listener never answers the same call again.
  func takeIncomingCalls() -> [[String: Any]] {
    var calls: [[String: Any]] = []
    for (id, call) in incoming {
      if call.state == "ringing" {
        calls.append(call.event("incoming"))
      } else if !call.delivered {
        calls.append(call.event("incoming"))
        incoming[id]?.delivered = true
      }
      if call.state == "declined" { incoming.removeValue(forKey: id) }
    }
    return calls
  }

  /// Tell JavaScript about a call's new state, noting whether anyone listened.
  private func deliver(_ id: UUID, _ type: String) {
    guard var call = incoming[id] else { return }
    call.delivered = emit != nil
    incoming[id] = call
    send(call.event(type))
  }

  // MARK: CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    for id in activeCalls { send(["type": "ended", "callId": id.uuidString.lowercased()]) }
    activeCalls.removeAll()
    incoming.removeAll()
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
    if var call = incoming[action.callUUID], call.state == "ringing" {
      // Declined on the ring screen (or the side button).
      call.state = "declined"
      incoming[action.callUUID] = call
      deliver(action.callUUID, "incomingDeclined")
      action.fulfill()
      return
    }
    incoming.removeValue(forKey: action.callUUID)
    activeCalls.remove(action.callUUID)
    send(["type": "ended", "callId": action.callUUID.uuidString.lowercased()])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard var call = incoming[action.callUUID], call.state == "ringing" else {
      return action.fail()
    }
    // CallKit activates this configuration; voice then runs as on any call.
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playAndRecord, mode: .voiceChat, options: Self.options(speaker: speaker))
    call.state = "answered"
    incoming[action.callUUID] = call
    activeCalls.insert(action.callUUID)
    deliver(action.callUUID, "incomingAnswered")
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

  private static var callKitRuns: Bool {
    #if targetEnvironment(simulator)
      return false
    #else
      return true
    #endif
  }

  private static func parseDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

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
