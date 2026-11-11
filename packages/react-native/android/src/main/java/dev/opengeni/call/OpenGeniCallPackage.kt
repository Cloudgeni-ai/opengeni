package dev.opengeni.call

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * During a call the app's screen shows over the lock screen, as a call app's
 * does. A voice command's launcher shortcut that opens the app becomes a start
 * request ([CallCommands]).
 */
class OpenGeniCallPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context?
  ): List<ReactActivityLifecycleListener> = listOf(CallActivityListener)

  private object CallActivityListener : ReactActivityLifecycleListener {
    private var context: Context? = null

    override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
      context = activity.applicationContext
      // A recreated activity (rotation, process restore) does not call again.
      if (savedInstanceState == null) CallCommands.handle(activity, activity.intent)
      attach(activity)
    }

    override fun onNewIntent(intent: Intent?): Boolean {
      val context = context ?: return false
      // Let others see it too: the shortcut only adds a start request.
      CallCommands.handle(context, intent)
      return false
    }

    override fun onResume(activity: Activity) = attach(activity)

    private fun attach(activity: Activity) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) SystemCalls.attach(activity)
    }
  }
}
