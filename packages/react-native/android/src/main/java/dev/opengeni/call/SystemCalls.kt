package dev.opengeni.call

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telecom.DisconnectCause
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import java.lang.ref.WeakReference
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Voice calls as Android system calls (Telecom, a self-managed call through
 * androidx core-telecom): what CallKit is on iOS. The system knows about the
 * call, so a cellular call holds it, Bluetooth headset buttons and watches
 * answer and hang up, and Telecom puts the phone into communication mode and
 * routes the audio. A foreground service with a call notification keeps it
 * going with the screen off or another app open.
 *
 * Agents' calls ring here too: a high-priority push reports the call, which
 * shows the incoming-call notification with a full-screen ring screen on the
 * lock screen. Answering hands the call to JavaScript as on iOS.
 *
 * One call at a time. The host app turns this on with the config plugin's
 * `call.androidSystemCall` option (manifest entries and the meta-data flag
 * below); without it calls use [CallAudio].
 */
@RequiresApi(Build.VERSION_CODES.O)
internal object SystemCalls {
  private const val TAG = "OpenGeniCall"
  const val META_ENABLED = "dev.opengeni.call.SYSTEM_CALLS"

  private class Session(
    val id: String,
    val incoming: Boolean,
    val title: String,
    val subtitle: String?,
  ) {
    var control: CallControlScope? = null
    var job: Job? = null
    val endpoints = MutableStateFlow<List<CallEndpointCompat>>(emptyList())
    val endpoint = MutableStateFlow<CallEndpointCompat?>(null)
    /** Outgoing calls are underway at once; incoming ones once answered here. */
    var answered = !incoming
    var connectedAt: Long? = null
    var ending = false
    var routeReported = false
    var lastMuted: Boolean? = null
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var manager: CallsManager? = null
  private var session: Session? = null
  private var callActivity: WeakReference<Activity>? = null
  /** Runs when the call ends, for the ring screen. */
  private val endListeners = mutableListOf<(String) -> Unit>()

  fun available(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val enabled =
      try {
        context.packageManager
          .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
          .metaData
          ?.getBoolean(META_ENABLED, false) == true
      } catch (error: Exception) {
        false
      }
    return enabled &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.MANAGE_OWN_CALLS) ==
        PackageManager.PERMISSION_GRANTED
  }

  /** Whether a call is underway or ringing. */
  val active: Boolean
    get() = session != null

  fun isRinging(id: String): Boolean = session?.let { it.id == id.lowercase() && !it.answered } == true

  fun onCallEnded(listener: (String) -> Unit): () -> Unit {
    endListeners.add(listener)
    return { endListeners.remove(listener) }
  }

  @Suppress("MissingPermission")
  private fun manager(context: Context): CallsManager {
    manager?.let {
      return it
    }
    val created = CallsManager(context.applicationContext)
    created.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
    manager = created
    return created
  }

  // MARK: Outgoing calls

  /**
   * Report a call the person started in the app, and wait until the system
   * has it, it is active and its audio is on the loudspeaker (or a connected
   * headset), so voice starts on the route it keeps.
   */
  suspend fun startOutgoing(context: Context, id: String, title: String) {
    val ready = CompletableDeferred<Unit>()
    session?.let { end(context, it.id, DisconnectCause.LOCAL) }
    val current = Session(id.lowercase(), incoming = false, title = title, subtitle = null)
    session = current
    current.job =
      scope.launch {
        try {
          addCall(context, current, CallAttributesCompat.DIRECTION_OUTGOING) {
            setActive()
            routeAtStart(current)
            reportStartRoute(current)
            OpenGeniCallService.show(context, current.title, current.subtitle, null)
            ready.complete(Unit)
          }
        } catch (error: Throwable) {
          if (!ready.isCompleted) ready.completeExceptionally(error)
          else if (!current.ending) Log.w(TAG, "The system call ended unexpectedly", error)
        } finally {
          finished(context, current)
        }
      }
    ready.await()
  }

  /** Voice is live: the call notification starts counting. */
  fun reportConnected(context: Context, id: String) {
    val current = session?.takeIf { it.id == id.lowercase() } ?: return
    if (current.connectedAt != null) return
    current.connectedAt = System.currentTimeMillis()
    OpenGeniCallService.show(context, current.title, current.subtitle, current.connectedAt)
  }

  /** End the call from the app (hang-up, voice failed or ended). */
  fun end(context: Context, id: String?, cause: Int = DisconnectCause.LOCAL) {
    val current = session ?: return
    if (id != null && current.id != id.lowercase()) return
    current.ending = true
    val control = current.control
    if (control == null) {
      current.job?.cancel()
      return
    }
    scope.launch {
      try {
        withTimeoutOrNull(2_000) { control.disconnect(DisconnectCause(cause)) }
      } catch (error: Exception) {
        Log.w(TAG, "Could not end the system call", error)
      }
      current.job?.cancel()
    }
  }

  fun setSpeaker(on: Boolean) {
    val current = session ?: return
    val control = current.control ?: return
    scope.launch {
      val endpoints = current.endpoints.value
      val target =
        if (on) endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }
        else
          endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_BLUETOOTH }
            ?: endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_WIRED_HEADSET }
            ?: endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_EARPIECE }
      if (target == null || current.endpoint.value?.type == target.type) return@launch
      val result = control.requestEndpointChange(target)
      if (result !is CallControlResult.Success) {
        Log.w(TAG, "Could not switch the call audio: $result")
      }
    }
  }

  // MARK: Incoming agent calls

  /** Ring an agent's call (a push): the incoming-call notification and ring screen. */
  fun reportIncoming(context: Context, call: IncomingCalls.Call) {
    scope.launch {
      val remaining =
        call.ringUntil?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
          ?.minus(System.currentTimeMillis())
          ?: 40_000L
      if (remaining <= 0 || IncomingCalls.get(call.id) != null) return@launch
      // On another call: this one rings out on the agent's side.
      if (session != null) return@launch
      val title = call.reason ?: call.title ?: "Your agent"
      val current = Session(call.id, incoming = true, title = title, subtitle = call.title)
      session = current
      current.job =
        scope.launch {
          try {
            addCall(context, current, CallAttributesCompat.DIRECTION_INCOMING) {
              IncomingCalls.ringing(call)
              CallNotifications.showIncoming(context, call.id, title, call.title, remaining)
            }
          } catch (error: Throwable) {
            if (!current.ending) Log.w(TAG, "Could not ring the agent's call", error)
          } finally {
            if (!current.answered && IncomingCalls.get(call.id)?.state == "ringing") {
              IncomingCalls.rangOut(call.id)
            }
            finished(context, current)
          }
        }
      scope.launch {
        delay(remaining + 1_000)
        if (session === current && !current.answered) {
          IncomingCalls.rangOut(call.id)
          end(context, call.id, DisconnectCause.MISSED)
        }
      }
    }
  }

  /** The person answered on the ring screen or the notification. */
  fun answer(context: Context, id: String) {
    val current = session?.takeIf { it.id == id.lowercase() && it.incoming && !it.answered } ?: return
    val control = current.control ?: return
    scope.launch {
      val result = control.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL)
      if (result !is CallControlResult.Success) {
        Log.w(TAG, "Could not answer the agent's call: $result")
        end(context, id, DisconnectCause.ERROR)
        return@launch
      }
      answered(context, current)
    }
  }

  /** The person declined on the ring screen or the notification. */
  fun decline(context: Context, id: String) {
    val current = session?.takeIf { it.id == id.lowercase() && !it.answered } ?: return
    IncomingCalls.declined(id)
    end(context, current.id, DisconnectCause.REJECTED)
  }

  /** Stop a ring that was settled elsewhere or rang out (from JavaScript or a push). */
  fun endIncoming(context: Context, id: String, reason: String) {
    val call = IncomingCalls.get(id) ?: return
    IncomingCalls.remove(id)
    val cause =
      when (reason) {
        "answeredElsewhere" -> DisconnectCause.ANSWERED_ELSEWHERE
        "declinedElsewhere" -> DisconnectCause.REJECTED
        "unanswered" -> DisconnectCause.MISSED
        "failed" -> DisconnectCause.ERROR
        else -> DisconnectCause.REMOTE
      }
    // An answered call is the app's voice call now: JavaScript ends it.
    if (call.state == "answered") return
    end(context, id, cause)
  }

  private suspend fun answered(context: Context, current: Session) {
    if (current.answered) return
    current.answered = true
    CallNotifications.cancelIncoming(context)
    routeAtStart(current)
    reportStartRoute(current)
    OpenGeniCallService.show(context, current.title, current.subtitle, null)
    IncomingCalls.answered(current.id)
  }

  // MARK: The call

  @Suppress("MissingPermission")
  private suspend fun addCall(
    context: Context,
    current: Session,
    direction: Int,
    onReady: suspend CallControlScope.() -> Unit,
  ) {
    val attributes =
      CallAttributesCompat(
        current.title,
        Uri.fromParts("opengeni", current.id, null),
        direction,
        CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
        CallAttributesCompat.SUPPORTS_SET_INACTIVE,
      )
    manager(context).addCall(
      attributes,
      onAnswer = { answered(context, current) },
      onDisconnect = { systemEnded(current) },
      onSetActive = {},
      onSetInactive = {},
    ) {
      current.control = this
      launch { availableEndpoints.collect { current.endpoints.value = it } }
      launch {
        currentCallEndpoint.collect { endpoint ->
          current.endpoint.value = endpoint
          reportRoute(current, endpoint)
        }
      }
      launch {
        isMuted.collect { muted ->
          val previous = current.lastMuted
          current.lastMuted = muted
          if (previous != null && previous != muted && current.answered) {
            CallEvents.send(mapOf("type" to "muteChanged", "callId" to current.id, "muted" to muted))
          }
        }
      }
      launch { onReady() }
    }
  }

  /**
   * A call starts on the loudspeaker, or on a headset when one is connected
   * (Telecom picks it), before voice starts, so the route never changes under
   * a live call. Bounded: a slow route change does not hold the call up.
   */
  private suspend fun routeAtStart(current: Session) {
    val control = current.control ?: return
    val endpoints = withTimeoutOrNull(1_000) { current.endpoints.first { it.isNotEmpty() } } ?: return
    val headset =
      endpoints.any {
        it.type == CallEndpointCompat.TYPE_BLUETOOTH || it.type == CallEndpointCompat.TYPE_WIRED_HEADSET
      }
    if (headset) return
    val speaker = endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER } ?: return
    if (current.endpoint.value?.type != CallEndpointCompat.TYPE_SPEAKER) {
      control.requestEndpointChange(speaker)
    }
    withTimeoutOrNull(1_000) {
      current.endpoint.first { it?.type == CallEndpointCompat.TYPE_SPEAKER }
    }
  }

  /** The route the call starts on, when settling it changed nothing. */
  private fun reportStartRoute(current: Session) {
    if (current.routeReported) return
    current.endpoint.value?.let { reportRoute(current, it) }
  }

  private fun reportRoute(current: Session, endpoint: CallEndpointCompat) {
    if (!current.answered) return
    val reason = if (current.routeReported) "override" else "activated"
    current.routeReported = true
    CallEvents.send(mapOf("type" to "routeChanged", "route" to routeName(endpoint.type), "reason" to reason))
  }

  /** The system ended the call: the lock screen, a headset, a watch or another call. */
  private fun systemEnded(current: Session) {
    if (current.ending) return
    current.ending = true
    if (current.incoming && !current.answered) {
      IncomingCalls.declined(current.id)
    } else {
      CallEvents.send(mapOf("type" to "ended", "callId" to current.id))
    }
    current.job?.cancel()
  }

  /** The notification's hang-up button. */
  fun hangUp(context: Context, id: String?) {
    val current = session ?: return
    if (id != null && current.id != id.lowercase()) return
    if (current.incoming && !current.answered) return decline(context, current.id)
    CallEvents.send(mapOf("type" to "ended", "callId" to current.id))
    end(context, current.id, DisconnectCause.LOCAL)
  }

  private fun finished(context: Context, current: Session) {
    if (session !== current) return
    session = null
    if (current.incoming && !current.answered) IncomingCalls.remove(current.id)
    CallNotifications.cancelIncoming(context)
    OpenGeniCallService.hide(context)
    callActivity?.get()?.let { activity -> CallWindow.release(activity) }
    callActivity = null
    endListeners.toList().forEach { it(current.id) }
  }

  /** The app's screen while a call runs: shown over the lock screen, like a call app's. */
  fun attach(activity: Activity) {
    if (session?.answered != true) return
    callActivity = WeakReference(activity)
    CallWindow.hold(activity)
  }

  private fun routeName(type: Int): String =
    when (type) {
      CallEndpointCompat.TYPE_SPEAKER -> "speaker"
      CallEndpointCompat.TYPE_EARPIECE -> "receiver"
      CallEndpointCompat.TYPE_BLUETOOTH -> "bluetooth"
      CallEndpointCompat.TYPE_WIRED_HEADSET -> "headphones"
      else -> "other"
    }
}

/** Showing the app's own screen over the lock screen during a call. */
internal object CallWindow {
  fun hold(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(true)
      activity.setTurnScreenOn(true)
    }
  }

  fun release(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(false)
      activity.setTurnScreenOn(false)
    }
  }
}
