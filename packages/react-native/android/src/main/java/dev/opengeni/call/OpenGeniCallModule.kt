package dev.opengeni.call

import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CallException(message: String) : CodedException(message)

/**
 * Voice calls on Android, with the same module surface as the iOS CallKit
 * module. Where the host turned system calls on (see [SystemCalls]), a call
 * is an Android system call with a call notification, and agents' calls ring
 * this phone. Otherwise a call sets up the phone's audio for voice
 * communication ([CallAudio]) without a system call, and agents cannot ring.
 */
class OpenGeniCallModule : Module() {
  private val context: Context
    get() =
      appContext.reactContext?.applicationContext
        ?: throw CallException("The app is not ready for a call.")

  private fun systemCalls(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      appContext.reactContext?.let { SystemCalls.available(it) } == true

  override fun definition() = ModuleDefinition {
    Name("OpenGeniCall")

    Events("onCallEvent")

    OnCreate { CallEvents.emit = { event -> sendEvent("onCallEvent", event) } }

    OnDestroy {
      CallAudio.end(null)
      CallEvents.emit = null
    }

    // Recents are an iOS call-history feature.
    Function("configure") { _: Boolean -> }

    /**
     * What this build offers: the system call, agents ringing this phone, and
     * whether a ring may show full screen now (Android 14 and later ask the
     * person; read it again when the app returns to the foreground).
     */
    Function("capabilities") {
      val system = systemCalls()
      mapOf(
        "systemCall" to system,
        "incoming" to (system && OpenGeniCallPush.available(context)),
        "fullScreenRing" to FullScreenRings.allowed(context),
      )
    }

    /** Open the system setting that lets rings show full screen; false when none opened. */
    AsyncFunction("openFullScreenRingSettings") { ->
      FullScreenRings.openSettings(context, appContext.currentActivity)
    }

    AsyncFunction("startCall") Coroutine { callId: String, title: String, _: String? ->
      if (systemCalls()) {
        try {
          SystemCalls.startOutgoing(context, callId, title)
          return@Coroutine
        } catch (error: Exception) {
          // The system refused the call (another call, a restriction): talk anyway.
          android.util.Log.w("OpenGeniCall", "System call unavailable; using call audio.", error)
        }
      }
      CallAudio.start(context, callId)
    }

    Function("reportConnected") { callId: String ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) SystemCalls.reportConnected(context, callId)
    }

    AsyncFunction("endCall") { callId: String, failed: Boolean ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && SystemCalls.active) {
        SystemCalls.end(
          context, callId, if (failed) android.telecom.DisconnectCause.ERROR else android.telecom.DisconnectCause.LOCAL)
      }
      CallAudio.end(callId)
    }

    // Muting stops the microphone track itself; the system keeps its own mute.
    AsyncFunction("setMuted") { _: String, _: Boolean -> }

    AsyncFunction("setSpeaker") { on: Boolean ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && SystemCalls.active) {
        SystemCalls.setSpeaker(on)
      } else {
        CallAudio.setSpeaker(on)
      }
    }

    // A voice command's launcher shortcut that opened the app.
    AsyncFunction("takePendingStartRequest") { -> CallEvents.takePendingStart() }

    // Voice commands: the signed-in account's chats as launcher shortcuts. An
    // empty list removes them all (signed out).
    AsyncFunction("setCallCommands") { commands: List<Map<String, Any?>> ->
      CallCommands.replace(context, commands.mapNotNull(CallCommands::parse))
    }

    /** Ask the launcher to put a voice command on the home screen. */
    AsyncFunction("pinCallCommand") { command: Map<String, Any?> ->
      val parsed = CallCommands.parse(command) ?: throw CallException("The voice command is incomplete.")
      CallCommands.pin(context, parsed)
    }

    // Agents' calls ring through the app's ordinary push token, not a VoIP token.
    AsyncFunction("getVoipToken") { -> null as String? }

    AsyncFunction("takeIncomingCalls") { -> IncomingCalls.take() }

    Function("endIncomingCall") { callId: String, reason: String ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        SystemCalls.endIncoming(context, callId, reason)
      }
    }
  }
}
