package dev.opengeni.call

import android.content.ComponentName
import android.content.Context
import android.os.Build
import org.json.JSONObject

/**
 * Agents' call rings in the app's push messages. The server sends a call as a
 * high-priority data message with an `opengeniCall` entry: a ring, or the end
 * of a ring that was settled elsewhere. The app's Firebase messaging service
 * (OpenGeniCallMessagingService, built when the app uses expo-notifications)
 * hands those here and every other message to expo-notifications.
 */
object OpenGeniCallPush {
  const val KEY = "opengeniCall"
  private const val SERVICE = "dev.opengeni.call.OpenGeniCallMessagingService"

  /** Whether this app receives call rings (its manifest declares the messaging service). */
  fun available(context: Context): Boolean =
    try {
      context.packageManager.getServiceInfo(ComponentName(context.packageName, SERVICE), 0)
      true
    } catch (error: Exception) {
      false
    }

  /**
   * Handle a push's data; false when it is not a call message this phone can
   * ring, so expo-notifications shows the ordinary "is calling" notification
   * the message also carries.
   */
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
      "ended" ->
        SystemCalls.endIncoming(
          context.applicationContext, callId, message.text("reason") ?: "remoteEnded")
      else -> return false
    }
    return true
  }

  private fun JSONObject.text(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).trim().takeIf { it.isNotEmpty() } else null
}
