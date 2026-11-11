package dev.opengeni.foreground

import android.Manifest
import android.app.Notification
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * Starts and stops one foreground service class so that no timing or failure
 * can make Android kill the app (see [ForegroundStarts]). The service calls
 * [handle] from onStartCommand() and returns START_NOT_STICKY.
 */
class ForegroundService(private val service: Class<out Service>) {
  companion object {
    /** Marks a start made with startForegroundService(), which owes a startForeground(). */
    const val EXTRA_OWED = "dev.opengeni.foreground.OWED"
  }

  private val starts = ForegroundStarts()

  /**
   * Start the service with [extras], or update it while it runs. Returns false
   * when Android allowed no start (the app is in the background on Android 12
   * and later, or the app does not declare the service).
   */
  fun start(context: Context, extras: Intent): Boolean {
    val intent = Intent(extras).setClass(context, service)
    val owing =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && maySettleOwedStart(context)) {
        { context.startForegroundService(Intent(intent).putExtra(EXTRA_OWED, true)) != null }
      } else null
    return starts.start({ context.startService(intent) != null }, owing)
  }

  /** Stop the service now, or as soon as stopping it is safe. */
  fun stop(context: Context) {
    starts.stop { context.stopService(Intent(context, service)) }
  }

  /**
   * Handle one start in onStartCommand(): go to the foreground with
   * [enterForeground] before anything else, then stop when the service is no
   * longer wanted or never reached the foreground. [enterForeground] returns
   * whether the service is in the foreground now; an exception counts as not.
   */
  fun handle(running: Service, intent: Intent?, startId: Int, enterForeground: () -> Boolean) {
    val inForeground =
      try {
        enterForeground()
      } catch (_: Exception) {
        false
      }
    starts.handled(intent?.getBooleanExtra(EXTRA_OWED, false) == true, inForeground) {
      // Leaves the service running when a newer start is on its way; that start decides.
      running.stopSelf(startId)
    }
  }

  /**
   * Whether startForeground() would settle an owed start even when it fails.
   * Android settles the start before refusing the foreground for being in the
   * background or for a type's permission (Android 12 and 14), but not before
   * checking the FOREGROUND_SERVICE permission and the service's declaration.
   * The service type is no risk: [goForeground] falls back to the declared types.
   */
  private fun maySettleOwedStart(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      context.checkSelfPermission(Manifest.permission.FOREGROUND_SERVICE) !=
        PackageManager.PERMISSION_GRANTED) {
      return false
    }
    return try {
      context.packageManager.getServiceInfo(ComponentName(context, service), 0)
      true
    } catch (_: Exception) {
      false
    }
  }
}

/**
 * Go to the foreground with the first of [types] Android accepts (Android 10
 * and later), then with the types the manifest declares, which always pass
 * the check that a type is declared. Returns the last error, or null once in
 * the foreground.
 */
fun Service.goForeground(id: Int, notification: Notification, vararg types: Int): Exception? {
  var last: Exception? = null
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    for (type in types) {
      try {
        startForeground(id, notification, type)
        return null
      } catch (error: Exception) {
        last = error
      }
    }
  }
  return try {
    startForeground(id, notification)
    null
  } catch (error: Exception) {
    last ?: error
  }
}

