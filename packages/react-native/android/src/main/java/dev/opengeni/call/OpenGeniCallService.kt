package dev.opengeni.call

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Keeps a call going with the screen off or another app open: a foreground
 * service of the phone-call and microphone types, whose notification is the
 * ongoing-call notification with Hang up.
 */
class OpenGeniCallService : Service() {
  companion object {
    private const val TAG = "OpenGeniCall"
    private const val EXTRA_CONNECTED_AT = "dev.opengeni.call.CONNECTED_AT"

    fun show(context: Context, title: String, subtitle: String?, connectedAt: Long?) {
      val intent =
        Intent(context, OpenGeniCallService::class.java)
          .putExtra(CallNotifications.EXTRA_TITLE, title)
          .putExtra(CallNotifications.EXTRA_SUBTITLE, subtitle)
      if (connectedAt != null) intent.putExtra(EXTRA_CONNECTED_AT, connectedAt)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (error: Exception) {
        // Not allowed from the background right now: the call itself still runs.
        Log.w(TAG, "Could not start the call service", error)
      }
    }

    fun hide(context: Context) {
      context.stopService(Intent(context, OpenGeniCallService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(CallNotifications.EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "Call"
    val subtitle = intent?.getStringExtra(CallNotifications.EXTRA_SUBTITLE)
    val connectedAt =
      intent?.takeIf { it.hasExtra(EXTRA_CONNECTED_AT) }?.getLongExtra(EXTRA_CONNECTED_AT, 0L)
    val notification = CallNotifications.ongoing(this, title, subtitle, connectedAt)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        try {
          startForeground(
            CallNotifications.ONGOING_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          )
        } catch (error: Exception) {
          // The microphone type needs the app in use; the phone-call type keeps the call alive.
          startForeground(
            CallNotifications.ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        }
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          CallNotifications.ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
      } else {
        startForeground(CallNotifications.ONGOING_ID, notification)
      }
    } catch (error: Exception) {
      Log.w(TAG, "Could not keep the call in the foreground", error)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    }
    super.onDestroy()
  }
}
