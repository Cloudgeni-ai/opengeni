import AVFoundation
import Foundation
import ObjectiveC

/// The audio session setup of a voice call, in one place.
///
/// Two parties configure the shared audio session during a call: CallKit
/// activates the configuration this module sets when a call starts or is
/// answered, and WebRTC applies its own configuration when voice audio starts
/// (`RTCAudioSessionConfiguration.webRTCConfiguration`, whose default has no
/// loudspeaker option). When the two differ, WebRTC's category change resets
/// the route seconds into the call: a loudspeaker call drops to the receiver.
/// Writing the same configuration to both means WebRTC finds the session
/// already set up and changes nothing, so the route stays where the call put
/// it, and where the person or a headset moves it afterwards.
enum OpenGeniCallAudio {
  static let category = AVAudioSession.Category.playAndRecord
  /// Voice chat: the voice-processing I/O unit's echo cancellation, which a
  /// loudspeaker call needs so the agent does not hear (and interrupt) itself.
  static let mode = AVAudioSession.Mode.voiceChat

  static func options(speaker: Bool) -> AVAudioSession.CategoryOptions {
    speaker ? [.allowBluetooth, .defaultToSpeaker] : [.allowBluetooth]
  }

  /// Configure the audio session for a call on the loudspeaker or receiver
  /// (a connected headset still wins), and make WebRTC use the same setup.
  static func configureSession(speaker: Bool) throws {
    matchWebRTC(speaker: speaker)
    try AVAudioSession.sharedInstance().setCategory(
      category, mode: mode, options: options(speaker: speaker))
  }

  /// Make the configuration WebRTC applies when voice audio starts the same as
  /// the call's. Its category and mode already are (play and record, voice
  /// chat); only the options differ. Resolved at run time: apps without WebRTC
  /// skip it.
  static func matchWebRTC(speaker: Bool) {
    guard let type = NSClassFromString("RTCAudioSessionConfiguration") else { return }
    let getter = NSSelectorFromString("webRTCConfiguration")
    let setter = NSSelectorFromString("setWebRTCConfiguration:")
    guard let get = class_getClassMethod(type, getter),
      let set = class_getClassMethod(type, setter)
    else { return }
    typealias Getter = @convention(c) (AnyClass, Selector) -> NSObject?
    typealias Setter = @convention(c) (AnyClass, Selector, NSObject) -> Void
    let current = unsafeBitCast(method_getImplementation(get), to: Getter.self)(type, getter)
    guard let configuration = current else { return }
    configuration.setValue(options(speaker: speaker).rawValue, forKey: "categoryOptions")
    unsafeBitCast(method_getImplementation(set), to: Setter.self)(type, setter, configuration)
  }

  // MARK: When the microphone may open

  /// Whether WebRTC runs its audio through the call audio device (built with
  /// the config plugin's `call.iosAudioDevice`), which honours the gate below.
  static var callAudioDeviceInstalled: Bool {
    guard let options = NSClassFromString("WebRTCModuleOptions") as AnyObject?,
      let device = NSClassFromString("OpenGeniCallAudioDevice"),
      options.responds(to: NSSelectorFromString("sharedInstance")),
      let shared = options.perform(NSSelectorFromString("sharedInstance"))?
        .takeUnretainedValue() as? NSObject,
      let current = shared.value(forKey: "audioDevice") as? NSObject
    else { return false }
    return current.isKind(of: device)
  }

  /// Posted (on any thread) when `microphoneAllowed` may have changed.
  static let gateDidChange = Notification.Name("OpenGeniCallAudioGateDidChange")

  private static let gateLock = NSLock()
  private static var systemCall = false
  private static var systemCallActivated = false

  /// Whether a call's audio may run now. During a system (CallKit) call that
  /// is only once CallKit has activated the audio session: an incoming call
  /// from its answer, an outgoing call from its start. Without a system call
  /// (the Simulator, or a call CallKit refused) the app runs its own audio.
  /// The call audio device sends silence while this is false, so a call can
  /// connect while the phone rings without opening the microphone.
  static var microphoneAllowed: Bool {
    gateLock.lock()
    defer { gateLock.unlock() }
    return !systemCall || systemCallActivated
  }

  /// Whether CallKit owns the audio session (a system call is ringing or live).
  static var systemCallOwnsSession: Bool {
    gateLock.lock()
    defer { gateLock.unlock() }
    return systemCall
  }

  static func setSystemCall(_ present: Bool) {
    updateGate { if !present { systemCallActivated = false }; systemCall = present }
  }

  static func setSystemCallActivated(_ activated: Bool) {
    updateGate { systemCallActivated = activated }
  }

  private static func updateGate(_ change: () -> Void) {
    gateLock.lock()
    let before = !systemCall || systemCallActivated
    let ownedBefore = systemCall
    change()
    let changed = before != (!systemCall || systemCallActivated) || ownedBefore != systemCall
    gateLock.unlock()
    if changed { NotificationCenter.default.post(name: gateDidChange, object: nil) }
  }
}
