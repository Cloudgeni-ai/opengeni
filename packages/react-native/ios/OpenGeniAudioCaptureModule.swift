import AVFoundation
import CryptoKit
import ExpoModulesCore
import UIKit

/// Options JavaScript passes to `start` (see `NativeAudioCapture` in src/recordings).
struct AudioCaptureStartOptions: Record {
  @Field var recordingId: String = ""
  @Field var directory: String = ""
  @Field var trackNumber: Int = 0
  @Field var chunkMilliseconds: Int = 5_000
  @Field var bitRate: Int = 64_000
  @Field var notificationTitle: String = ""
  @Field var notificationText: String = ""
}

/// Meeting and site-walk recording: the microphone as AAC in ADTS frames,
/// cut into chunk files in the recording's directory. ADTS frames carry
/// their own headers, so chunks concatenate into one stream and a file cut
/// short by a crash is good up to its last whole frame. Capture continues in
/// the background (the app declares the `audio` background mode); a phone
/// call or another app taking the microphone pauses it, and it resumes by
/// itself afterwards.
public final class OpenGeniAudioCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenGeniAudioCapture")

    Events("onChunk", "onState", "onError")

    OnCreate {
      AudioCapture.shared.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    AsyncFunction("start") { (options: AudioCaptureStartOptions) -> [String: Any?] in
      try AudioCapture.shared.start(options)
    }

    Function("pause") { AudioCapture.shared.pause() }

    AsyncFunction("resume") { try AudioCapture.shared.resume() }

    AsyncFunction("stop") { () -> [String: Any]? in AudioCapture.shared.stop(cancel: false) }

    AsyncFunction("cancel") { () -> Void in _ = AudioCapture.shared.stop(cancel: true) }

    Function("elapsedMilliseconds") { AudioCapture.shared.elapsedMilliseconds }

    Function("level") { AudioCapture.shared.level }

    Function("activeRecordingId") { AudioCapture.shared.recordingId }
  }
}

enum AudioCaptureError: Error, CustomStringConvertible {
  case busy
  case noInput
  case encoder
  case notCapturing

  var description: String {
    switch self {
    case .busy: return "Another recording is in progress."
    case .noInput: return "No microphone could be opened."
    case .encoder: return "The audio encoder could not start."
    case .notCapturing: return "Nothing is being recorded."
    }
  }
}

/// One capture at a time, shared across JavaScript reloads.
final class AudioCapture {
  static let shared = AudioCapture()

  /// AAC-LC, 48 kHz, mono: the ADTS headers below assume exactly this.
  private static let sampleRate = 48_000.0
  private static let samplesPerPacket: Int64 = 1_024

  var emit: ((String, [String: Any?]) -> Void)?

  private let queue = DispatchQueue(label: "dev.opengeni.audiocapture")
  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var resampler: AVAudioConverter?
  private var encoder: AVAudioConverter?
  private let pcmFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: AudioCapture.sampleRate, channels: 1,
    interleaved: false)!
  private var aacFormat: AVAudioFormat?

  private var options = AudioCaptureStartOptions()
  private var directory: URL?
  private var active: String?
  private var pausedByPerson = false
  private var interrupted = false
  private var observers: [NSObjectProtocol] = []

  // Timeline, in samples at 48 kHz, of audio handed to the encoder.
  private var samplesFed: Int64 = 0
  private var samplesEncoded: Int64 = 0
  private var currentLevel: Double = 0

  // The chunk being written.
  private var chunkNumber = 0
  private var chunkStartSamples: Int64 = 0
  private var chunkSamples: Int64 = 0
  private var chunkHandle: FileHandle?
  private var chunkPartURL: URL?
  private var chunkBytes = 0

  var recordingId: String? {
    lock.lock()
    defer { lock.unlock() }
    return active
  }

  var level: Double {
    lock.lock()
    defer { lock.unlock() }
    return active == nil || pausedByPerson || interrupted ? 0 : currentLevel
  }

  var elapsedMilliseconds: Double {
    lock.lock()
    defer { lock.unlock() }
    return Double(samplesFed) * 1_000 / AudioCapture.sampleRate
  }

  // MARK: Lifecycle

  func start(_ options: AudioCaptureStartOptions) throws -> [String: Any?] {
    try queue.sync {
      if active != nil { throw AudioCaptureError.busy }
      self.options = options
      let url =
        options.directory.hasPrefix("file:")
        ? URL(string: options.directory)! : URL(fileURLWithPath: options.directory)
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      directory = url

      var description = AudioStreamBasicDescription(
        mSampleRate: AudioCapture.sampleRate, mFormatID: kAudioFormatMPEG4AAC,
        mFormatFlags: UInt32(MPEG4ObjectID.AAC_LC.rawValue), mBytesPerPacket: 0,
        mFramesPerPacket: UInt32(AudioCapture.samplesPerPacket), mBytesPerFrame: 0,
        mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
      guard let aac = AVAudioFormat(streamDescription: &description),
        let encoder = AVAudioConverter(from: pcmFormat, to: aac)
      else { throw AudioCaptureError.encoder }
      encoder.bitRate = max(24_000, min(options.bitRate, 192_000))
      aacFormat = aac
      self.encoder = encoder

      samplesFed = 0
      samplesEncoded = 0
      chunkNumber = 0
      pausedByPerson = false
      interrupted = false
      try activateSession()
      try startEngine()
      setActive(options.recordingId)
      observe()
      try openChunk()
    }
    let input = AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName
    return ["sampleRate": AudioCapture.sampleRate, "inputName": input]
  }

  func pause() {
    queue.sync {
      guard active != nil, !pausedByPerson else { return }
      pausedByPerson = true
      stopEngine()
    }
  }

  func resume() throws {
    try queue.sync {
      guard active != nil else { throw AudioCaptureError.notCapturing }
      guard pausedByPerson else { return }
      pausedByPerson = false
      if interrupted { return }
      try activateSession()
      try startEngine()
    }
  }

  /// Stop capture. Returns the final chunk, or nil when there was none or when cancelled.
  func stop(cancel: Bool) -> [String: Any]? {
    queue.sync {
      guard active != nil else { return nil }
      stopEngine()
      var last: [String: Any]?
      if cancel {
        discardChunk()
      } else {
        flushEncoder()
        last = closeChunk(emitEvent: true)
      }
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
      encoder = nil
      resampler = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      let id = active
      setActive(nil)
      if let id { send("onState", ["recordingId": id, "state": "stopped"]) }
      return last
    }
  }

  private func setActive(_ id: String?) {
    lock.lock()
    active = id
    lock.unlock()
  }

  // MARK: Audio session and engine

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    // Mixing keeps other apps' audio from interrupting the recording.
    try session.setCategory(
      .playAndRecord, mode: .default,
      options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker])
    try session.setActive(true)
  }

  private func startEngine() throws {
    stopEngine()
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw AudioCaptureError.noInput }
    if format.sampleRate != pcmFormat.sampleRate || format.channelCount != 1
      || format.commonFormat != .pcmFormatFloat32
    {
      guard let resampler = AVAudioConverter(from: format, to: pcmFormat) else {
        throw AudioCaptureError.encoder
      }
      resampler.downmix = true
      self.resampler = resampler
    } else {
      resampler = nil
    }
    input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
      guard let self, let copy = AudioCapture.copy(buffer) else { return }
      self.queue.async { self.receive(copy) }
    }
    engine.prepare()
    try engine.start()
    self.engine = engine
  }

  private func stopEngine() {
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
  }

  private func observe() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
      ) { [weak self] note in self?.queue.async { self?.interruption(note) } },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) {
        [weak self] _ in
        // A route or format change (headphones, Bluetooth) stopped the engine: start it again.
        self?.queue.async { self?.restartIfRunning() }
      },
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
      ) { [weak self] _ in
        self?.queue.async {
          try? self?.activateSession()
          self?.restartIfRunning()
        }
      },
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
      ) { [weak self] _ in
        // An interruption that never reported its end: try again when the app is back.
        self?.queue.async {
          guard let self, self.interrupted else { return }
          self.endInterruption()
        }
      },
    ]
  }

  private func interruption(_ note: Notification) {
    guard active != nil,
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    if type == .began {
      guard !interrupted else { return }
      interrupted = true
      stopEngine()
      if let id = active { send("onState", ["recordingId": id, "state": "interrupted"]) }
    } else {
      endInterruption()
    }
  }

  private func endInterruption() {
    guard active != nil, interrupted else { return }
    if !pausedByPerson {
      do {
        try activateSession()
        try startEngine()
      } catch {
        // Still taken (the call goes on); the next notification or foregrounding tries again.
        return
      }
    }
    interrupted = false
    if let id = active { send("onState", ["recordingId": id, "state": "recording"]) }
  }

  private func restartIfRunning() {
    guard active != nil, !pausedByPerson, !interrupted else { return }
    do {
      try startEngine()
    } catch {
      if let id = active {
        send(
          "onError",
          ["recordingId": id, "code": "capture_failed", "message": "\(error)"])
      }
    }
  }

  // MARK: Encoding

  private static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard
      let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength)
    else { return nil }
    copy.frameLength = buffer.frameLength
    let channels = Int(buffer.format.channelCount)
    let frames = Int(buffer.frameLength)
    if let source = buffer.floatChannelData, let target = copy.floatChannelData {
      for channel in 0..<channels {
        target[channel].update(from: source[channel], count: frames)
      }
    } else if let source = buffer.int16ChannelData, let target = copy.int16ChannelData {
      for channel in 0..<channels {
        target[channel].update(from: source[channel], count: frames)
      }
    } else {
      return nil
    }
    return copy
  }

  private func receive(_ buffer: AVAudioPCMBuffer) {
    guard active != nil, !pausedByPerson, !interrupted, buffer.frameLength > 0 else { return }
    guard let pcm = toPcm(buffer), pcm.frameLength > 0 else { return }
    if let samples = pcm.floatChannelData?[0] {
      var sum: Float = 0
      for index in 0..<Int(pcm.frameLength) { sum += samples[index] * samples[index] }
      let rms = sqrt(sum / Float(pcm.frameLength))
      lock.lock()
      currentLevel = Double(min(1, rms * 4))
      lock.unlock()
    }
    lock.lock()
    samplesFed += Int64(pcm.frameLength)
    lock.unlock()
    encode(pcm, endOfStream: false)
  }

  private func toPcm(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let resampler else { return buffer }
    let ratio = pcmFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: capacity) else {
      return nil
    }
    var provided = false
    var error: NSError?
    resampler.convert(to: output, error: &error) { _, status in
      if provided {
        status.pointee = .noDataNow
        return nil
      }
      provided = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil ? output : nil
  }

  private func encode(_ pcm: AVAudioPCMBuffer?, endOfStream: Bool) {
    guard let encoder, let aacFormat else { return }
    var provided = false
    while true {
      let output = AVAudioCompressedBuffer(
        format: aacFormat, packetCapacity: 16,
        maximumPacketSize: max(encoder.maximumOutputPacketSize, 1_536))
      var error: NSError?
      let status = encoder.convert(to: output, error: &error) { _, inputStatus in
        if let pcm, !provided {
          provided = true
          inputStatus.pointee = .haveData
          return pcm
        }
        inputStatus.pointee = endOfStream ? .endOfStream : .noDataNow
        return nil
      }
      write(output)
      if status != .haveData { break }
    }
  }

  private func flushEncoder() {
    encode(nil, endOfStream: true)
  }

  private func write(_ output: AVAudioCompressedBuffer) {
    guard output.packetCount > 0, let descriptions = output.packetDescriptions else { return }
    var data = Data()
    let base = output.data
    for index in 0..<Int(output.packetCount) {
      let description = descriptions[index]
      let size = Int(description.mDataByteSize)
      guard size > 0 else { continue }
      data.append(contentsOf: AudioCapture.adtsHeader(payload: size))
      data.append(base.advanced(by: Int(description.mStartOffset)).assumingMemoryBound(to: UInt8.self), count: size)
      samplesEncoded += AudioCapture.samplesPerPacket
      chunkSamples += AudioCapture.samplesPerPacket
    }
    guard !data.isEmpty else { return }
    chunkHandle?.write(data)
    chunkBytes += data.count
    let chunkTarget = Int64(options.chunkMilliseconds) * Int64(AudioCapture.sampleRate) / 1_000
    if chunkSamples >= chunkTarget {
      _ = closeChunk(emitEvent: true)
      try? openChunk()
    }
  }

  /// The 7-byte ADTS header for one AAC-LC frame at 48 kHz, mono, without CRC.
  private static func adtsHeader(payload: Int) -> [UInt8] {
    let length = payload + 7
    let profile: UInt8 = 1  // AAC LC (object type 2) minus one
    let frequencyIndex: UInt8 = 3  // 48 kHz
    let channels: UInt8 = 1
    return [
      0xFF, 0xF1,
      (profile << 6) | (frequencyIndex << 2) | (channels >> 2),
      ((channels & 0x03) << 6) | UInt8((length >> 11) & 0x03),
      UInt8((length >> 3) & 0xFF),
      UInt8(((length & 0x07) << 5) | 0x1F),
      0xFC,
    ]
  }

  // MARK: Chunk files

  private func milliseconds(_ samples: Int64) -> Int64 {
    samples * 1_000 / Int64(AudioCapture.sampleRate)
  }

  private func openChunk() throws {
    guard let directory else { return }
    chunkStartSamples = samplesEncoded
    chunkSamples = 0
    chunkBytes = 0
    let name = String(
      format: "t%d-c%06d-s%lld.part", options.trackNumber, chunkNumber,
      milliseconds(chunkStartSamples))
    let url = directory.appendingPathComponent(name)
    FileManager.default.createFile(atPath: url.path, contents: nil)
    chunkHandle = try FileHandle(forWritingTo: url)
    chunkPartURL = url
  }

  /// Finish the chunk being written: name it after its contents and report it.
  private func closeChunk(emitEvent: Bool) -> [String: Any]? {
    guard let handle = chunkHandle, let part = chunkPartURL, let directory else { return nil }
    try? handle.synchronize()
    try? handle.close()
    chunkHandle = nil
    chunkPartURL = nil
    guard chunkBytes > 0, let bytes = try? Data(contentsOf: part) else {
      try? FileManager.default.removeItem(at: part)
      return nil
    }
    let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    let start = milliseconds(chunkStartSamples)
    let duration = milliseconds(chunkSamples)
    let name = String(
      format: "t%d-c%06d-s%lld-d%lld-b%d-%@.chunk", options.trackNumber, chunkNumber, start,
      duration, bytes.count, sha)
    let target = directory.appendingPathComponent(name)
    try? FileManager.default.removeItem(at: target)
    do {
      try FileManager.default.moveItem(at: part, to: target)
    } catch {
      return nil
    }
    let event: [String: Any] = [
      "recordingId": options.recordingId,
      "trackNumber": options.trackNumber,
      "chunkNumber": chunkNumber,
      "startMilliseconds": start,
      "durationMilliseconds": duration,
      "byteLength": bytes.count,
      "sha256": sha,
      "fileName": name,
    ]
    chunkNumber += 1
    if emitEvent { send("onChunk", event) }
    return event
  }

  private func discardChunk() {
    try? chunkHandle?.close()
    chunkHandle = nil
    if let part = chunkPartURL { try? FileManager.default.removeItem(at: part) }
    chunkPartURL = nil
  }

  private func send(_ name: String, _ body: [String: Any?]) {
    emit?(name, body)
  }
}
