package dev.opengeni.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** Decline and Hang up on the call notifications. */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL_ID)
    when (intent.action) {
      CallNotifications.ACTION_DECLINE -> callId?.let { SystemCalls.decline(context, it) }
      CallNotifications.ACTION_HANG_UP -> SystemCalls.hangUp(context, callId)
    }
  }
}
