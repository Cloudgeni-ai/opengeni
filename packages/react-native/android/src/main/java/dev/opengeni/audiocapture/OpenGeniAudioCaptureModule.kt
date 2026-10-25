package dev.opengeni.audiocapture

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** Options JavaScript passes to `start` (see `NativeAudioCapture` in src/recordings). */
class AudioCaptureStartOptions : Record {
  @Field var recordingId: String = ""
  @Field var directory: String = ""
  @Field var trackNumber: Int = 0
  @Field var chunkMilliseconds: Int = 5_000
  @Field var bitRate: Int = 64_000
  @Field var notificationTitle: String = ""
  @Field var notificationText: String = ""
}

class AudioCaptureException(message: String) : CodedException(message)

/**
 * Meeting and site-walk recording: the microphone as AAC in ADTS frames, cut
 * into chunk files in the recording's directory. A foreground service with
 * the microphone type keeps capture going while the app is in the background.
 * When the system gives the microphone to someone else (a phone call, another
 * app), capture pauses and resumes by itself.
 */
class OpenGeniAudioCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenGeniAudioCapture")

    Events("onChunk", "onState", "onError", "onPcm")

    OnCreate { AudioCapture.emit = { name, body -> sendEvent(name, body) } }

    OnDestroy { AudioCapture.emit = null }

    AsyncFunction("start") { options: AudioCaptureStartOptions ->
      val context =
        appContext.reactContext?.applicationContext
          ?: throw AudioCaptureException("The app is not ready to record.")
      AudioCapture.start(context, options)
    }

    Function("pause") { AudioCapture.pause() }

    AsyncFunction("resume") { AudioCapture.resume() }

    AsyncFunction("stop") { AudioCapture.stop(cancel = false) }

    AsyncFunction("cancel") {
      AudioCapture.stop(cancel = true)
      Unit
    }

    Function("elapsedMilliseconds") { AudioCapture.elapsedMilliseconds() }

    Function("level") { AudioCapture.level() }

    Function("activeRecordingId") { AudioCapture.recordingId() }

    Function("setLivePcm") { enabled: Boolean -> AudioCapture.setLivePcm(enabled) }
  }
}
