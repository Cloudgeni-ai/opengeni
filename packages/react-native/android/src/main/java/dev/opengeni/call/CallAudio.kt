package dev.opengeni.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The phone's audio set up for a voice call while one runs: what CallKit's
 * audio session does on iOS. Starting takes audio focus for voice
 * communication, switches the phone into communication mode (the mode its
 * voice-call microphone processing and routing expect) and routes the call
 * to a connected headset, or else the loudspeaker. Ending puts back what was
 * there before.
 */
internal object CallAudio {
  private const val TAG = "OpenGeniCall"

  @Volatile var emit: ((Map<String, Any?>) -> Unit)? = null

  private val main = Handler(Looper.getMainLooper())

  /** Headsets in the order a call prefers them over the built-in speakers. */
  private val HEADSETS =
    listOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_HEARING_AID,
    )

  private var audio: AudioManager? = null
  private var callId: String? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var previousMicrophoneMute = false
  private var previousSpeakerphone = false
  private var focusRequest: AudioFocusRequest? = null
  private val focusListener = AudioManager.OnAudioFocusChangeListener {}
  private var devices: AudioDeviceCallback? = null
  private var lastRoute: String? = null

  /** The loudspeaker rather than the earpiece when no headset is used. */
  private var speaker = true

  /** The person chose the loudspeaker: it wins over a connected headset. */
  private var forceSpeaker = false

  @Synchronized
  fun start(context: Context, id: String) {
    callId?.let { end(it) }
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audio = manager
    callId = id.lowercase()
    speaker = true
    forceSpeaker = false
    previousMode = manager.mode
    previousMicrophoneMute = manager.isMicrophoneMute
    @Suppress("DEPRECATION")
    previousSpeakerphone = manager.isSpeakerphoneOn
    attempt("request audio focus") { requestFocus(manager) }
    attempt("enter communication mode") { manager.mode = AudioManager.MODE_IN_COMMUNICATION }
    attempt("unmute the microphone") {
      if (manager.isMicrophoneMute) manager.isMicrophoneMute = false
    }
    val route = applyRoute(manager)
    watchDevices(manager)
    send(route, "activated")
  }

  @Synchronized
  fun end(id: String?) {
    val manager = audio ?: return
    if (id != null && id.lowercase() != callId) return
    devices?.let { callback -> attempt("stop watching devices") { manager.unregisterAudioDeviceCallback(callback) } }
    devices = null
    attempt("restore the audio route") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        manager.clearCommunicationDevice()
      } else {
        @Suppress("DEPRECATION")
        manager.isSpeakerphoneOn = previousSpeakerphone
      }
    }
    attempt("restore the audio mode") { manager.mode = previousMode }
    attempt("restore the microphone") {
      if (manager.isMicrophoneMute != previousMicrophoneMute) {
        manager.isMicrophoneMute = previousMicrophoneMute
      }
    }
    attempt("abandon audio focus") { abandonFocus(manager) }
    audio = null
    callId = null
    lastRoute = null
  }

  @Synchronized
  fun setSpeaker(on: Boolean) {
    speaker = on
    forceSpeaker = on
    val manager = audio ?: return
    send(applyRoute(manager), "override")
  }

  @Synchronized
  private fun devicesChanged(reason: String) {
    val manager = audio ?: return
    val route = applyRoute(manager)
    // Registering reports every present device once: only real changes count.
    if (route != lastRoute) send(route, reason)
  }

  private fun send(route: String, reason: String) {
    lastRoute = route
    emit?.invoke(mapOf("type" to "routeChanged", "route" to route, "reason" to reason))
  }

  /** Route the call and say where it went. */
  private fun applyRoute(manager: AudioManager): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val available = manager.availableCommunicationDevices
      val headset =
        if (forceSpeaker) null
        else HEADSETS.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } }
      val builtIn =
        if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
      val target = headset ?: available.firstOrNull { it.type == builtIn }
      attempt("route call audio") {
        if (target == null || !manager.setCommunicationDevice(target)) {
          manager.clearCommunicationDevice()
        }
      }
      return routeName(target?.type ?: manager.communicationDevice?.type)
    }
    val headset =
      !forceSpeaker &&
        manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
          it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
            it.type == AudioDeviceInfo.TYPE_USB_HEADSET
        }
    val loud = !headset && speaker
    attempt("route call audio") {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = loud
    }
    return if (headset) "headphones" else if (loud) "speaker" else "receiver"
  }

  private fun routeName(type: Int?): String =
    when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "receiver"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "headphones"
      else -> "other"
    }

  private fun watchDevices(manager: AudioManager) {
    val callback =
      object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) =
          devicesChanged("newDevice")

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) =
          devicesChanged("oldDeviceUnavailable")
      }
    attempt("watch devices") {
      manager.registerAudioDeviceCallback(callback, main)
      devices = callback
    }
  }

  private fun requestFocus(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes =
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val request =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(attributes)
          .setOnAudioFocusChangeListener(focusListener, main)
          .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        focusListener,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN,
      )
    }
  }

  private fun abandonFocus(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { manager.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      manager.abandonAudioFocus(focusListener)
    }
  }

  /** Audio setup is best effort: a call still runs if one step is refused. */
  private inline fun attempt(step: String, block: () -> Unit) {
    try {
      block()
    } catch (error: Exception) {
      Log.w(TAG, "Could not $step for the call", error)
    }
  }
}
