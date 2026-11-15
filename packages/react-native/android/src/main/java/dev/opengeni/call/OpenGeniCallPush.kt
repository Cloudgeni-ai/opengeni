package dev.opengeni.call

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject

/**
 * Agents' call rings in the app's push messages. The server sends a call as a
 * high-priority data message with an `opengeniCall` entry: a ring, or the end
 * of a ring that was settled elsewhere. The app's Firebase messaging service
 * hands those here: either OpenGeniCallMessagingService (declared by the
 * config plugin when the app uses expo-notifications), which passes every
 * other message on to expo-notifications, or, with the plugin's
 * `call.androidMessagingService: "app"`, the app's own service:
 *
 * ```kotlin
 * override fun onMessageReceived(message: RemoteMessage) {
 *   if (OpenGeniCallPush.handle(this, message.data)) return
 *   // ...the app's own handling
 * }
 * ```
 */
object OpenGeniCallPush {
  /** The data entry that carries a call: JSON with `type` `"ring"` or `"ended"`. */
  const val KEY = "opengeniCall"
  private const val SERVICE = "dev.opengeni.call.OpenGeniCallMessagingService"
  /** Set by the config plugin when the app's own messaging service calls [handle]. */
  const val META_APP_MESSAGING_SERVICE = "dev.opengeni.call.APP_MESSAGING_SERVICE"

  /**
   * Whether this app receives call rings: its manifest declares
   * OpenGeniCallMessagingService, or marks the app's own messaging service as
   * handing rings to [handle].
   */
  @JvmStatic
  fun available(context: Context): Boolean = declaresService(context) || appDeliversRings(context)

  private fun declaresService(context: Context): Boolean =
    try {
      context.packageManager.getServiceInfo(ComponentName(context.packageName, SERVICE), 0)
      true
    } catch (error: Exception) {
      false
    }

  private fun appDeliversRings(context: Context): Boolean =
    try {
      context.packageManager
        .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        .metaData
        ?.getBoolean(META_APP_MESSAGING_SERVICE, false) == true
    } catch (error: Exception) {
      false
    }

  /**
   * Handle a push's data (`RemoteMessage.data`). Call it first from the app's
   * Firebase messaging service's `onMessageReceived`; it returns quickly and
   * is safe on the service's background thread.
   *
   * True when it consumed the message: a ring it reported as an incoming
   * system call, or the end of a ring settled elsewhere. Stop there; the app
   * shows nothing for it. False for any other message, and for a ring this
   * phone cannot show as a system call (Android before 8.0, system calls off
   * or not permitted): handle it as an ordinary push, which for a ring means
   * showing the "… is calling" notification from its `title` and `message`
   * entries.
   */
  @JvmStatic
  fun handle(context: Context, data: Map<String, String>): Boolean {
    val raw = data[KEY] ?: return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !SystemCalls.available(context)) return false
    val message = runCatching { JSONObject(raw) }.getOrNull() ?: return false
    val callId = message.optString("callId").lowercase().takeIf { it.isNotEmpty() } ?: return false
    when (message.optString("type")) {
      "ring" -> {
        val sessionId = message.optString("sessionId")
        val workspaceId = message.optString("workspaceId")
        if (sessionId.isEmpty() || workspaceId.isEmpty()) return false
        SystemCalls.reportIncoming(
          context.applicationContext,
          IncomingCalls.Call(
            id = callId,
            sessionId = sessionId,
            workspaceId = workspaceId,
            subjectId = message.text("subjectId"),
            title = message.text("title"),
            reason = message.text("reason"),
            ringUntil = message.text("ringUntil"),
          ),
        )
      }
      // Settled elsewhere: stop the ring. The phone that answered keeps its
      // call; its own app ends it.
      "ended" ->
        if (IncomingCalls.get(callId)?.state == "ringing") {
          SystemCalls.endIncoming(
            context.applicationContext, callId, message.text("reason") ?: "remoteEnded")
        }
      else -> return false
    }
    return true
  }

  private fun JSONObject.text(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).trim().takeIf { it.isNotEmpty() } else null
}
