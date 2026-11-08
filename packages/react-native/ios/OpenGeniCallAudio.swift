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
}
