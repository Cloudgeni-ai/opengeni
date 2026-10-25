package dev.opengeni.audiocapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the app in the foreground, with the microphone type, while it records,
 * so capture goes on with the screen off or another app open. Its ongoing
 * notification returns to the app.
 */
class OpenGeniAudioCaptureService : Service() {
  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL = "opengeni-recording"
    private const val NOTIFICATION_ID = 0x0A0D10
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "Recording audio"
    val text = intent?.getStringExtra(EXTRA_TEXT)?.takeIf { it.isNotBlank() } ?: ""
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
        })
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val open =
      launch?.let {
        PendingIntent.getActivity(
          this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(this)
    val notification =
      builder
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(applicationInfo.icon)
        .setOngoing(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .apply { if (open != null) setContentIntent(open) }
        .build()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: Exception) {
      // Not allowed now (the app went to the background first, or the host app does not
      // declare the microphone service type): recording goes on while the app is open.
      AudioCapture.reportForegroundUnavailable(error.message ?: "")
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
