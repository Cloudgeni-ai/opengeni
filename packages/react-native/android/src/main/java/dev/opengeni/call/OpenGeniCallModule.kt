package dev.opengeni.call

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CallException(message: String) : CodedException(message)

/**
 * Voice calls on Android: the same module surface as the iOS CallKit module,
 * without a system call screen. A call sets up the phone's audio for voice
 * communication (see [CallAudio]); without it WebRTC records and plays as if
 * no call were running. Agents cannot ring an Android phone, so the incoming
 * call functions are absent.
 */
class OpenGeniCallModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenGeniCall")

    Events("onCallEvent")

    OnCreate { CallAudio.emit = { event -> sendEvent("onCallEvent", event) } }

    OnDestroy {
      CallAudio.end(null)
      CallAudio.emit = null
    }

    // Recents are an iOS call-history feature.
    Function("configure") { _: Boolean -> }

    AsyncFunction("startCall") { callId: String, _: String, _: String? ->
      val context =
        appContext.reactContext?.applicationContext
          ?: throw CallException("The app is not ready for a call.")
      CallAudio.start(context, callId)
    }

    Function("reportConnected") { _: String -> }

    AsyncFunction("endCall") { callId: String, _: Boolean -> CallAudio.end(callId) }

    // Muting stops the microphone track itself; there is no system call to tell.
    AsyncFunction("setMuted") { _: String, _: Boolean -> }

    AsyncFunction("setSpeaker") { on: Boolean -> CallAudio.setSpeaker(on) }

    // Nothing outside the app starts calls on Android.
    AsyncFunction("takePendingStartRequest") { -> null as Map<String, Any?>? }
  }
}
