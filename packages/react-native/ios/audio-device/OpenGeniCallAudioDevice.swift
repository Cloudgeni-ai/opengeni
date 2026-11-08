import AVFoundation
import AudioToolbox
import Foundation
import WebRTC

/// WebRTC's audio device for calls (built with the config plugin's
/// `call.iosAudioDevice`), in place of WebRTC's built-in one.
///
/// The built-in device opens the microphone and activates the audio session
/// as soon as a call connects. This one waits for `OpenGeniCallAudio`'s gate:
/// while a system call rings it sends silence and opens nothing, so the call
/// can connect (and the far end hear a live, silent line) before the person
/// answers. Once CallKit activates the session, or at once when no system
/// call is involved, it runs Apple's voice-processing I/O unit, as WebRTC's
/// own device does: echo cancellation, noise suppression and gain control
/// come from that unit (WebRTC's media engine turns its own off on iOS).
///
/// Threads: WebRTC calls the device on its audio device thread; every state
/// change runs on `control`, which never waits for that thread (parameter
/// changes are posted to it with `dispatchAsync`), so WebRTC may wait for
/// `control`. Silence runs on `io`; the audio unit on its own real-time thread.
@objc(OpenGeniCallAudioDevice)
final class OpenGeniCallAudioDevice: NSObject, RTCAudioDevice {
  private enum Mode { case off, silent, live }

  /// Silence goes out in 10 ms blocks at 48 kHz, WebRTC's native frame.
  private static let silentRate = 48_000.0
  private static let silentBufferDuration = 0.01
  private static let silentFrames: UInt32 = 480
  /// What the session is asked for during a live call (WebRTC's defaults).
  private static let preferredRate = 48_000.0
  private static let preferredBufferDuration = 0.02

  private let control = DispatchQueue(label: "dev.opengeni.call.audio-device")
  private let io = DispatchQueue(label: "dev.opengeni.call.audio-device.io", qos: .userInteractive)
  private let lock = NSLock()

  // Guarded by `lock`: what WebRTC asked for, and what the device reports.
  private var delegate: RTCAudioDeviceDelegate?
  private var initialized = false
  private var playoutInitialized = false
  private var recordingInitialized = false
  private var playing = false
  private var recording = false
  private var mode = Mode.off
  private var liveRate = silentRate
  private var liveBufferDuration = silentBufferDuration
  private var liveInputLatency: TimeInterval = 0
  private var liveOutputLatency: TimeInterval = 0

  // Owned by `control`.
  private var observers: [NSObjectProtocol] = []
  private var timer: DispatchSourceTimer?
  private var interrupted = false
  /// The device activated the session itself (no system call); it deactivates it.
  private var activatedSession = false
  /// Bumped on every transition, so a stale posted step does nothing.
  private var generation = 0

  // Read on the audio unit's thread; set on `control` while the unit is stopped.
  private var unit: AudioUnit?
  private var deliverRecorded: RTCAudioDeviceDeliverRecordedDataBlock?
  private var playoutData: RTCAudioDeviceGetPlayoutDataBlock?
  private lazy var renderRecorded: RTCAudioDeviceRenderRecordedDataBlock = {
    [unowned self] flags, timestamp, bus, frames, buffers, _ in
    guard let unit = self.unit else { return kAudioUnitErr_Uninitialized }
    return AudioUnitRender(unit, flags, timestamp, UInt32(bus), frames, buffers)
  }

  // MARK: RTCAudioDevice: parameters

  var deviceInputSampleRate: Double { locked { mode == .live ? liveRate : Self.silentRate } }
  var inputIOBufferDuration: TimeInterval {
    locked { mode == .live ? liveBufferDuration : Self.silentBufferDuration }
  }
  var inputNumberOfChannels: Int { 1 }
  var inputLatency: TimeInterval { locked { mode == .live ? liveInputLatency : 0 } }
  var deviceOutputSampleRate: Double { deviceInputSampleRate }
  var outputIOBufferDuration: TimeInterval { inputIOBufferDuration }
  var outputNumberOfChannels: Int { 1 }
  var outputLatency: TimeInterval { locked { mode == .live ? liveOutputLatency : 0 } }

  // MARK: RTCAudioDevice: lifecycle

  var isInitialized: Bool { locked { initialized } }
  var isPlayoutInitialized: Bool { locked { playoutInitialized } }
  var isPlaying: Bool { locked { playing } }
  var isRecordingInitialized: Bool { locked { recordingInitialized } }
  var isRecording: Bool { locked { recording } }

  func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
    locked {
      self.delegate = delegate
      initialized = true
    }
    control.async { self.observe() }
    return true
  }

  func terminateDevice() -> Bool {
    locked {
      playing = false
      recording = false
      playoutInitialized = false
      recordingInitialized = false
    }
    // Synchronously: WebRTC may free the delegate once this returns.
    control.sync {
      generation += 1
      stopLive()
      stopSilence()
      deactivateSession()
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
      locked {
        mode = .off
        delegate = nil
        initialized = false
      }
    }
    return true
  }

  func initializePlayout() -> Bool {
    locked { playoutInitialized = true }
    return true
  }

  func startPlayout() -> Bool {
    locked { playing = true }
    control.async { self.update() }
    return true
  }

  func stopPlayout() -> Bool {
    locked {
      playing = false
      playoutInitialized = false
    }
    control.async { self.update() }
    return true
  }

  func initializeRecording() -> Bool {
    locked { recordingInitialized = true }
    return true
  }

  func startRecording() -> Bool {
    locked { recording = true }
    control.async { self.update() }
    return true
  }

  func stopRecording() -> Bool {
    locked {
      recording = false
      recordingInitialized = false
    }
    control.async { self.update() }
    return true
  }

  // MARK: Transitions (on `control`)

  private func observe() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    func on(_ name: Notification.Name, _ object: Any?, _ handle: @escaping (Notification) -> Void) {
      observers.append(
        center.addObserver(forName: name, object: object, queue: nil) { [weak self] note in
          self?.control.async { handle(note) }
        })
    }
    on(OpenGeniCallAudio.gateDidChange, nil) { [weak self] _ in self?.update() }
    on(AVAudioSession.interruptionNotification, session) { [weak self] note in
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      self?.interrupted = raw.flatMap(AVAudioSession.InterruptionType.init) == .began
      self?.update()
    }
    on(AVAudioSession.mediaServicesWereResetNotification, session) { [weak self] _ in
      // Every audio object is gone: start over from a new unit.
      guard let self else { return }
      if let unit = self.unit { AudioComponentInstanceDispose(unit) }
      self.unit = nil
      self.activatedSession = false
      self.locked { self.mode = .off }
      self.update()
    }
    on(AVAudioSession.routeChangeNotification, session) { [weak self] _ in
      guard let self, self.locked({ self.mode }) == .live else { return }
      // A headset or car can change the hardware rate (Bluetooth calls run at
      // 16 kHz): rebuild the unit at the new rate and tell WebRTC.
      let session = AVAudioSession.sharedInstance()
      if session.sampleRate != self.locked({ self.liveRate }) {
        self.stopLive()
        self.locked { self.mode = .off }
        self.update()
      } else {
        self.locked {
          self.liveInputLatency = session.inputLatency
          self.liveOutputLatency = session.outputLatency
        }
      }
    }
  }

  /// Move to the mode WebRTC's requests and the gate call for.
  private func update() {
    let (wanted, current) = locked { () -> (Mode, Mode) in
      let wanted: Mode =
        !(playing || recording)
        ? .off : (!interrupted && OpenGeniCallAudio.microphoneAllowed ? .live : .silent)
      return (wanted, mode)
    }
    guard wanted != current || (wanted == .live && unit == nil) else { return }
    generation += 1
    switch wanted {
    case .off:
      stopLive()
      stopSilence()
      deactivateSession()
      locked { mode = .off }
    case .silent:
      stopLive()
      locked { mode = .silent }
      announceParameters { [weak self] in self?.startSilence() }
    case .live:
      stopSilence()
      guard prepareLive() else {
        // The session could not run (another app holds it, or CallKit has
        // not activated it yet): keep the line silent and try again on the
        // next change.
        locked { mode = .silent }
        announceParameters { [weak self] in self?.startSilence() }
        return
      }
      locked { mode = .live }
      announceParameters { [weak self] in self?.startLive() }
    }
  }

  /// Tell WebRTC the device's rate and buffer size changed, then (back on
  /// `control`) run `next` unless another transition came first.
  private func announceParameters(then next: @escaping () -> Void) {
    let expected = generation
    guard let delegate = locked({ delegate }) else { return }
    delegate.dispatchAsync { [weak self, weak delegate] in
      // The IO threads change with the mode: WebRTC re-checks them after this.
      delegate?.notifyAudioInputInterrupted()
      delegate?.notifyAudioOutputInterrupted()
      delegate?.notifyAudioInputParametersChange()
      delegate?.notifyAudioOutputParametersChange()
      self?.control.async {
        guard let self, self.generation == expected else { return }
        next()
      }
    }
  }

  // MARK: Silence

  private func startSilence() {
    guard timer == nil, let delegate = locked({ delegate }) else { return }
    let deliver = delegate.deliverRecordedData
    let pull = delegate.getPlayoutData
    let frames = Self.silentFrames
    let bytes = Int(frames) * MemoryLayout<Int16>.size
    let samples = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 16)
    let discard = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 16)
    var sampleTime = 0.0
    let source = DispatchSource.makeTimerSource(flags: .strict, queue: io)
    source.schedule(
      deadline: .now(), repeating: .milliseconds(10), leeway: .microseconds(500))
    source.setEventHandler { [weak self] in
      guard let self else { return }
      let (recording, playing) = self.locked { (self.recording, self.playing) }
      var timestamp = AudioTimeStamp()
      timestamp.mSampleTime = sampleTime
      timestamp.mHostTime = mach_absolute_time()
      timestamp.mFlags = [.sampleTimeValid, .hostTimeValid]
      sampleTime += Double(frames)
      var flags = AudioUnitRenderActionFlags()
      if recording {
        samples.initializeMemory(as: UInt8.self, repeating: 0, count: bytes)
        var list = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: samples))
        _ = deliver(&flags, &timestamp, 1, frames, &list, nil, nil)
      }
      // Whatever the far end sends before the person answers is not played
      // later in a burst: it is taken and dropped here.
      if playing {
        var list = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: discard))
        _ = pull(&flags, &timestamp, 0, frames, &list)
      }
    }
    source.setCancelHandler {
      samples.deallocate()
      discard.deallocate()
    }
    timer = source
    source.resume()
  }

  private func stopSilence() {
    guard let source = timer else { return }
    timer = nil
    source.cancel()
    // The last tick has finished once the IO queue has drained.
    io.sync {}
  }

  // MARK: Live audio

  /// Make sure the session is active and build the unit at its rate.
  private func prepareLive() -> Bool {
    let session = AVAudioSession.sharedInstance()
    if !OpenGeniCallAudio.systemCallOwnsSession, !activatedSession {
      do {
        try OpenGeniCallAudio.configureSession(speaker: true)
        try session.setActive(true)
        activatedSession = true
      } catch {
        NSLog("[OpenGeniCallAudioDevice] Could not activate the audio session: %@", "\(error)")
        return false
      }
    }
    try? session.setPreferredSampleRate(Self.preferredRate)
    try? session.setPreferredIOBufferDuration(Self.preferredBufferDuration)
    let rate = session.sampleRate > 0 ? session.sampleRate : Self.preferredRate
    guard makeUnit(rate: rate) else { return false }
    locked {
      liveRate = rate
      liveBufferDuration =
        session.ioBufferDuration > 0 ? session.ioBufferDuration : Self.preferredBufferDuration
      liveInputLatency = session.inputLatency
      liveOutputLatency = session.outputLatency
    }
    return true
  }

  private func startLive() {
    guard let unit, let delegate = locked({ delegate }) else { return }
    deliverRecorded = delegate.deliverRecordedData
    playoutData = delegate.getPlayoutData
    // Created here, not lazily on the real-time thread.
    _ = renderRecorded
    let status = AudioOutputUnitStart(unit)
    if status != noErr {
      NSLog("[OpenGeniCallAudioDevice] Could not start voice processing: %d", status)
      stopLive()
      locked { mode = .silent }
      generation += 1
      announceParameters { [weak self] in self?.startSilence() }
    }
  }

  private func stopLive() {
    guard let unit else { return }
    // Returns once the unit's callbacks have finished.
    AudioOutputUnitStop(unit)
    AudioUnitUninitialize(unit)
    AudioComponentInstanceDispose(unit)
    self.unit = nil
  }

  private func deactivateSession() {
    guard activatedSession else { return }
    activatedSession = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Apple's voice-processing I/O unit, 16-bit mono at `rate` both ways, as
  /// WebRTC's own device sets it up.
  private func makeUnit(rate: Double) -> Bool {
    var description = AudioComponentDescription(
      componentType: kAudioUnitType_Output,
      componentSubType: kAudioUnitSubType_VoiceProcessingIO,
      componentManufacturer: kAudioUnitManufacturer_Apple,
      componentFlags: 0, componentFlagsMask: 0)
    guard let component = AudioComponentFindNext(nil, &description) else { return false }
    var created: AudioUnit?
    guard AudioComponentInstanceNew(component, &created) == noErr, let unit = created else {
      return false
    }
    let me = Unmanaged.passUnretained(self).toOpaque()
    var on: UInt32 = 1
    var off: UInt32 = 0
    var format = AudioStreamBasicDescription(
      mSampleRate: rate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var record = AURenderCallbackStruct(inputProc: Self.recorded, inputProcRefCon: me)
    var play = AURenderCallbackStruct(inputProc: Self.playout, inputProcRefCon: me)
    let u32 = UInt32(MemoryLayout<UInt32>.size)
    let steps: [(String, OSStatus)] = [
      ("enable input", AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, u32)),
      ("enable output", AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &on, u32)),
      ("record format", AudioUnitSetProperty(
        unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format,
        UInt32(MemoryLayout<AudioStreamBasicDescription>.size))),
      ("playout format", AudioUnitSetProperty(
        unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format,
        UInt32(MemoryLayout<AudioStreamBasicDescription>.size))),
      // WebRTC renders the microphone into its own buffer.
      ("no input buffer", AudioUnitSetProperty(
        unit, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, &off, u32)),
      ("input callback", AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &record,
        UInt32(MemoryLayout<AURenderCallbackStruct>.size))),
      ("render callback", AudioUnitSetProperty(
        unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &play,
        UInt32(MemoryLayout<AURenderCallbackStruct>.size))),
      ("initialize", AudioUnitInitialize(unit)),
    ]
    if let failed = steps.first(where: { $0.1 != noErr }) {
      NSLog("[OpenGeniCallAudioDevice] Voice processing setup failed (%@): %d", failed.0, failed.1)
      AudioComponentInstanceDispose(unit)
      return false
    }
    self.unit = unit
    return true
  }

  private static let recorded: AURenderCallback = { refCon, flags, timestamp, bus, frames, _ in
    let device = Unmanaged<OpenGeniCallAudioDevice>.fromOpaque(refCon).takeUnretainedValue()
    guard let deliver = device.deliverRecorded else { return noErr }
    return deliver(flags, timestamp, Int(bus), frames, nil, nil, device.renderRecorded)
  }

  private static let playout: AURenderCallback = { refCon, flags, timestamp, bus, frames, data in
    let device = Unmanaged<OpenGeniCallAudioDevice>.fromOpaque(refCon).takeUnretainedValue()
    guard let data else { return noErr }
    guard let pull = device.playoutData else {
      flags.pointee.insert(.unitRenderAction_OutputIsSilence)
      for buffer in UnsafeMutableAudioBufferListPointer(data) {
        if let bytes = buffer.mData { memset(bytes, 0, Int(buffer.mDataByteSize)) }
      }
      return noErr
    }
    return pull(flags, timestamp, Int(bus), frames, data)
  }

  // MARK: Helpers

  @discardableResult
  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
