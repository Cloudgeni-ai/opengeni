package dev.opengeni.call

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import dev.opengeni.foreground.ForegroundService
import dev.opengeni.foreground.goForeground

/**
 * Keeps a call going with the screen off or another app open: a foreground
 * service of the phone-call and microphone types, whose notification is the
 * ongoing-call notification with Hang up. Started and stopped through a
 * [ForegroundService], so no timing or failure crashes the app.
 */
class OpenGeniCallService : Service() {
  companion object {
    private const val TAG = "OpenGeniCall"
    private const val EXTRA_CONNECTED_AT = "dev.opengeni.call.CONNECTED_AT"
    private val service = ForegroundService(OpenGeniCallService::class.java)

    fun show(context: Context, title: String, subtitle: String?, connectedAt: Long?) {
      val intent =
        Intent()
          .putExtra(CallNotifications.EXTRA_TITLE, title)
          .putExtra(CallNotifications.EXTRA_SUBTITLE, subtitle)
      if (connectedAt != null) intent.putExtra(EXTRA_CONNECTED_AT, connectedAt)
      if (!service.start(context, intent)) {
        // Not allowed from the background right now: the call itself still runs.
        Log.w(TAG, "Could not start the call service")
      }
    }

    fun hide(context: Context) {
      service.stop(context)
    }
  }

  private var inForeground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    service.handle(this, intent, startId) { enterForeground(intent) }
    return START_NOT_STICKY
  }

  private fun enterForeground(intent: Intent?): Boolean {
    val title = intent?.getStringExtra(CallNotifications.EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "Call"
    val subtitle = intent?.getStringExtra(CallNotifications.EXTRA_SUBTITLE)
    val connectedAt =
      intent?.takeIf { it.hasExtra(EXTRA_CONNECTED_AT) }?.getLongExtra(EXTRA_CONNECTED_AT, 0L)
    val notification = CallNotifications.ongoing(this, title, subtitle, connectedAt)
    // The microphone type needs the app in use; the phone-call type keeps the call alive.
    val types =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        intArrayOf(
          ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
      } else {
        intArrayOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
      }
    val error = goForeground(CallNotifications.ONGOING_ID, notification, *types)
    if (error == null) inForeground = true
    else Log.w(TAG, "Could not keep the call in the foreground", error)
    return inForeground
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    }
    super.onDestroy()
  }
}
