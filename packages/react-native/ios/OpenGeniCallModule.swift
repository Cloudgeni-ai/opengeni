import ExpoModulesCore

public class OpenGeniCallModule: Module {
  private let center = OpenGeniCallCenter.shared

  public func definition() -> ModuleDefinition {
    Name("OpenGeniCall")

    Events("onCallEvent")

    OnStartObserving {
      self.center.emit = { [weak self] event in self?.sendEvent("onCallEvent", event) }
    }

    OnStopObserving {
      self.center.emit = nil
    }

    Function("configure") { (includeInRecents: Bool) in
      DispatchQueue.main.async { self.center.configure(includeInRecents: includeInRecents) }
    }

    AsyncFunction("startCall") { (callId: String, title: String, target: String?, promise: Promise) in
      guard let id = UUID(uuidString: callId) else {
        return promise.reject("ERR_CALL_ID", "Call id must be a UUID")
      }
      self.center.startCall(id: id, title: title, target: target) { error in
        if let error {
          promise.reject("ERR_CALL_START", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }
    }
    .runOnQueue(.main)

    Function("reportConnected") { (callId: String) in
      guard let id = UUID(uuidString: callId) else { return }
      DispatchQueue.main.async { self.center.reportConnected(id: id) }
    }

    AsyncFunction("endCall") { (callId: String, failed: Bool, promise: Promise) in
      guard let id = UUID(uuidString: callId) else { return promise.resolve(nil) }
      self.center.endCall(id: id, failed: failed) { promise.resolve(nil) }
    }
    .runOnQueue(.main)

    AsyncFunction("setMuted") { (callId: String, muted: Bool, promise: Promise) in
      guard let id = UUID(uuidString: callId) else { return promise.resolve(nil) }
      self.center.setMuted(id: id, muted: muted) { promise.resolve(nil) }
    }
    .runOnQueue(.main)

    AsyncFunction("setSpeaker") { (on: Bool) in
      try self.center.setSpeaker(on)
    }
    .runOnQueue(.main)

    AsyncFunction("takePendingStartRequest") { () -> [String: Any]? in
      self.center.takePendingStart()
    }
    .runOnQueue(.main)
  }
}
