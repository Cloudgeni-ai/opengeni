package dev.opengeni.call

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.opengeni.textselection.R

/**
 * The ring screen an agent's call shows on the lock screen or over other
 * apps (the incoming-call notification's full-screen intent): who calls and
 * why, Decline and Answer. Answering opens the app on the call.
 */
class IncomingCallActivity : Activity() {
  private var callId: String? = null
  private var stopListening: (() -> Unit)? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    showOverLockScreen()
    if (!handle(intent)) return
    render(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (handle(intent)) render(intent)
  }

  override fun onDestroy() {
    stopListening?.invoke()
    stopListening = null
    super.onDestroy()
  }

  /** False when there is nothing to ring for (it ended, or Answer was pressed). */
  private fun handle(intent: Intent): Boolean {
    val id = intent.getStringExtra(CallNotifications.EXTRA_CALL_ID)
    if (id == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !SystemCalls.isRinging(id)) {
      finish()
      return false
    }
    callId = id
    stopListening?.invoke()
    stopListening =
      SystemCalls.onCallEnded { ended -> if (ended == id) runOnUiThread { finish() } }
    if (intent.action == CallNotifications.ACTION_ANSWER) {
      answer()
      return false
    }
    return true
  }

  private fun answer() {
    val id = callId ?: return finish()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) SystemCalls.answer(applicationContext, id)
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(launch)
    }
    finish()
  }

  private fun decline() {
    val id = callId
    if (id != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      SystemCalls.decline(applicationContext, id)
    }
    finish()
  }

  private fun showOverLockScreen() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = BACKGROUND
  }

  private fun render(intent: Intent) {
    val title = intent.getStringExtra(CallNotifications.EXTRA_TITLE) ?: "Your agent"
    val subtitle = intent.getStringExtra(CallNotifications.EXTRA_SUBTITLE)
    val appName = applicationInfo.loadLabel(packageManager).toString()

    val root =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setBackgroundColor(BACKGROUND)
        setPadding(dp(32), dp(96), dp(32), dp(72))
      }

    root.addView(
      ImageView(this).apply {
        setImageDrawable(applicationInfo.loadIcon(packageManager))
        contentDescription = appName
        clipToOutline = true
        background = GradientDrawable().apply { cornerRadius = dp(20).toFloat() }
      },
      LinearLayout.LayoutParams(dp(72), dp(72)))

    root.addView(
      text("$appName call", 15f, SECONDARY).apply { setPadding(0, dp(20), 0, 0) },
      wrap())
    root.addView(
      text(title, 30f, Color.WHITE, bold = true).apply {
        setPadding(0, dp(12), 0, 0)
        maxLines = 4
      },
      wrap())
    if (!subtitle.isNullOrBlank() && subtitle != title) {
      root.addView(text(subtitle, 17f, SECONDARY).apply { setPadding(0, dp(8), 0, 0) }, wrap())
    }

    root.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))

    val buttons =
      LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
      }
    buttons.addView(
      button("Decline", R.drawable.opengeni_call_end, DECLINE) { decline() },
      LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    buttons.addView(
      button("Answer", R.drawable.opengeni_call_notification, ANSWER) { answer() },
      LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    root.addView(
      buttons,
      LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    setContentView(root)
  }

  private fun button(label: String, icon: Int, color: Int, onPress: () -> Unit): View {
    val column =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
      }
    val circle =
      FrameLayout(this).apply {
        background = GradientDrawable().apply {
          shape = GradientDrawable.OVAL
          setColor(color)
        }
        contentDescription = label
        isClickable = true
        isFocusable = true
        setOnClickListener { onPress() }
        addView(
          ImageView(context).apply { setImageResource(icon) },
          FrameLayout.LayoutParams(dp(32), dp(32), Gravity.CENTER))
      }
    column.addView(circle, LinearLayout.LayoutParams(dp(76), dp(76)))
    column.addView(text(label, 15f, Color.WHITE).apply { setPadding(0, dp(12), 0, 0) }, wrap())
    return column
  }

  private fun text(value: String, size: Float, color: Int, bold: Boolean = false) =
    TextView(this).apply {
      text = value
      setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
      setTextColor(color)
      gravity = Gravity.CENTER_HORIZONTAL
      if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }

  private fun wrap() =
    LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private companion object {
    val BACKGROUND = Color.rgb(17, 18, 20)
    val SECONDARY = Color.argb(178, 255, 255, 255)
    val DECLINE = Color.rgb(229, 72, 77)
    val ANSWER = Color.rgb(48, 164, 108)
  }
}
