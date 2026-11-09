package dev.opengeni.call

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** During a call the app's screen shows over the lock screen, as a call app's does. */
class OpenGeniCallPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context?
  ): List<ReactActivityLifecycleListener> = listOf(CallActivityListener)

  private object CallActivityListener : ReactActivityLifecycleListener {
    override fun onCreate(activity: Activity, savedInstanceState: Bundle?) = attach(activity)

    override fun onResume(activity: Activity) = attach(activity)

    private fun attach(activity: Activity) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) SystemCalls.attach(activity)
    }
  }
}
