package dev.opengeni.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import dev.opengeni.textselection.R

/**
 * The system's call notifications: the incoming-call notification an agent's
 * call rings with (Answer and Decline, and a full-screen ring screen on the
 * lock screen), and the ongoing-call notification with Hang up.
 */
internal object CallNotifications {
  const val INCOMING_CHANNEL = "opengeni-call-ringing"
  const val ONGOING_CHANNEL = "opengeni-call-ongoing"
  const val INCOMING_ID = 0x0CA11
  const val ONGOING_ID = 0x0CA12

  const val ACTION_ANSWER = "dev.opengeni.call.ANSWER"
  const val ACTION_DECLINE = "dev.opengeni.call.DECLINE"
  const val ACTION_HANG_UP = "dev.opengeni.call.HANG_UP"
  const val EXTRA_CALL_ID = "dev.opengeni.call.CALL_ID"
  const val EXTRA_TITLE = "dev.opengeni.call.TITLE"
  const val EXTRA_SUBTITLE = "dev.opengeni.call.SUBTITLE"

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(INCOMING_CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(INCOMING_CHANNEL, "Calls from agents", NotificationManager.IMPORTANCE_HIGH)
          .apply {
            description = "Rings when an agent calls you"
            setSound(
              RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 1_000, 1_000)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          })
    }
    if (manager.getNotificationChannel(ONGOING_CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(ONGOING_CHANNEL, "Ongoing calls", NotificationManager.IMPORTANCE_DEFAULT)
          .apply {
            description = "Shows while you're on a call with an agent"
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
          })
    }
  }

  fun showIncoming(context: Context, callId: String, title: String, subtitle: String?, ringMillis: Long) {
    channels(context)
    val ringScreen = ringScreenIntent(context, callId, title, subtitle, answer = false)
    val answer = ringScreenIntent(context, callId, title, subtitle, answer = true)
    val decline = broadcast(context, ACTION_DECLINE, callId, 3)
    val caller = Person.Builder().setName(title).setImportant(true).build()
    val notification =
      NotificationCompat.Builder(context, INCOMING_CHANNEL)
        .setSmallIcon(R.drawable.opengeni_call_notification)
        .setContentTitle(title)
        .apply { if (subtitle != null) setContentText(subtitle) }
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(ringScreen)
        .setFullScreenIntent(ringScreen, true)
        .setTimeoutAfter(ringMillis + 1_000)
        .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
        .build()
    // Ring until answered, declined or rung out, as a phone does.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    notify(context, INCOMING_ID, notification)
  }

  fun cancelIncoming(context: Context) {
    context.getSystemService(NotificationManager::class.java)?.cancel(INCOMING_ID)
  }

  /** The ongoing call: who is on it, since when, and Hang up. */
  fun ongoing(context: Context, title: String, subtitle: String?, connectedAt: Long?): Notification {
    channels(context)
    val caller = Person.Builder().setName(title).setImportant(true).build()
    val hangUp = broadcast(context, ACTION_HANG_UP, null, 4)
    return NotificationCompat.Builder(context, ONGOING_CHANNEL)
      .setSmallIcon(R.drawable.opengeni_call_notification)
      .setContentTitle(title)
      .apply { if (subtitle != null) setContentText(subtitle) }
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setSilent(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .apply {
        openApp(context)?.let { setContentIntent(it) }
        if (connectedAt != null) {
          setWhen(connectedAt)
          setUsesChronometer(true)
          setShowWhen(true)
        }
      }
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUp))
      .build()
  }

  /** The app's own screen, brought back as it was. */
  fun openApp(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context, 5, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun ringScreenIntent(
    context: Context,
    callId: String,
    title: String,
    subtitle: String?,
    answer: Boolean,
  ): PendingIntent {
    val intent =
      Intent(context, IncomingCallActivity::class.java)
        .setAction(if (answer) ACTION_ANSWER else Intent.ACTION_VIEW)
        .putExtra(EXTRA_CALL_ID, callId)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_SUBTITLE, subtitle)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      if (answer) 2 else 1,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun broadcast(context: Context, action: String, callId: String?, requestCode: Int): PendingIntent {
    val intent =
      Intent(context, CallActionReceiver::class.java).setAction(action).setPackage(context.packageName)
    if (callId != null) intent.putExtra(EXTRA_CALL_ID, callId)
    return PendingIntent.getBroadcast(
      context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun notify(context: Context, id: Int, notification: Notification) {
    try {
      context.getSystemService(NotificationManager::class.java)?.notify(id, notification)
    } catch (error: SecurityException) {
      // Notifications are off for the app: the call still rings out on the agent's side.
      android.util.Log.w("OpenGeniCall", "Could not show the call notification", error)
    }
  }
}
