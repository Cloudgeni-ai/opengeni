package dev.opengeni.call

import android.app.Activity
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Whether an agent's ring shows full screen over the lock screen, like a
 * phone call. From Android 14, Play grants USE_FULL_SCREEN_INTENT up front
 * only to apps whose core function is calling or alarms; in any other app the
 * person allows it in system settings, and until then a ring is only a
 * heads-up notification.
 */
internal object FullScreenRings {
  fun allowed(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
    val manager = context.getSystemService(NotificationManager::class.java) ?: return true
    return try {
      manager.canUseFullScreenIntent()
    } catch (error: Exception) {
      true
    }
  }

  /**
   * Open this app's "full-screen notifications" setting, or its notification
   * settings on a phone without that screen. False when neither opened.
   */
  fun openSettings(context: Context, activity: Activity?): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
    val packageName = context.packageName
    val intents =
      listOf(
        Intent(
          Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
          Uri.fromParts("package", packageName, null)),
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
      )
    for (intent in intents) {
      try {
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        return true
      } catch (error: ActivityNotFoundException) {
        continue
      } catch (error: SecurityException) {
        continue
      }
    }
    return false
  }
}
