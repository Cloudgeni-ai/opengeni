package dev.opengeni.textselection

import android.app.Activity
import android.os.Build
import android.text.Selection
import android.text.Spannable
import android.view.ActionMode
import android.view.HapticFeedbackConstants
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.TextView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Add note on selected timeline text. Android's selectable text already
 * selects any range with the system handles and menu; inside a view whose
 * test id starts with `og-annotation-source:` and names a source, the menu
 * also offers Add note while JavaScript listens, reporting the selected text
 * and its surroundings.
 */
class OpenGeniTextSelectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenGeniTextSelection")

    Events("onAnnotate")

    OnCreate { install() }

    OnActivityEntersForeground { install() }

    OnStartObserving {
      TextSelectionState.emit = { event -> sendEvent("onAnnotate", event) }
    }

    OnStopObserving { TextSelectionState.emit = null }

    /** The Add note title, localized by JavaScript; null hides Add note. */
    Function("setAnnotateTitle") { title: String? -> TextSelectionState.title = title }

    /**
     * Where each draft quote is drawn inside a source, in the source view's
     * coordinates (dp): `{ x, top, rects }`, the end of its last glyph, the
     * top of that line's text and one text box per line (flattened x, y,
     * width, height), or an empty map when the quote is not drawn there.
     */
    AsyncFunction("quoteAnchors") { sourceKey: String, queries: List<Map<String, String>> ->
      QuoteAnchors.measure(appContext.currentActivity, sourceKey, queries)
    }.runOnQueue(Queues.MAIN)
  }

  private fun install() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      val window = activity.window ?: return@runOnUiThread
      val callback = window.callback ?: return@runOnUiThread
      if (callback !is AnnotationWindowCallback) {
        window.callback = AnnotationWindowCallback(callback, activity)
      }
    }
  }
}

internal object TextSelectionState {
  const val SOURCE_PREFIX = "og-annotation-source:"
  var emit: ((Map<String, Any?>) -> Unit)? = null
  var title: String? = null

  /** The source key of the timeline message `view` sits in, if any. */
  fun sourceKey(view: View): String? {
    var current: View? = view
    while (current != null) {
      val tag = current.tag
      if (tag is String && tag.startsWith(SOURCE_PREFIX)) return tag.removePrefix(SOURCE_PREFIX)
      current = current.parent as? View
    }
    return null
  }
}

internal object QuoteAnchors {
  fun measure(
    activity: Activity?,
    sourceKey: String,
    queries: List<Map<String, String>>,
  ): List<Map<String, Any>> {
    val none = queries.map { emptyMap<String, Any>() }
    val root = activity?.window?.decorView ?: return none
    val source =
      root.findViewWithTag<View>(TextSelectionState.SOURCE_PREFIX + sourceKey) ?: return none
    val texts = mutableListOf<TextView>()
    collect(source, texts)
    return queries.map { query ->
      val quote = query["quote"]?.trim().orEmpty()
      if (quote.isEmpty()) return@map emptyMap<String, Any>()
      var best: Triple<TextView, Int, Int>? = null
      for (view in texts) {
        val string = view.text?.toString() ?: continue
        var index = string.indexOf(quote)
        while (index >= 0) {
          val score =
            commonSuffix(string.substring(0, index), query["before"].orEmpty()) +
              commonPrefix(string.substring(index + quote.length), query["after"].orEmpty())
          if (best == null || score > best.third) best = Triple(view, index, score)
          index = string.indexOf(quote, index + 1)
        }
      }
      best?.let { anchor(it.first, it.second, it.second + quote.length, source) }
        ?: emptyMap()
    }
  }

  private fun anchor(view: TextView, start: Int, end: Int, source: View): Map<String, Any> {
    val layout = view.layout ?: return emptyMap()
    val string = view.text.toString()
    val density = view.resources.displayMetrics.density
    val viewAt = IntArray(2).also(view::getLocationInWindow)
    val sourceAt = IntArray(2).also(source::getLocationInWindow)
    val dx = (viewAt[0] - sourceAt[0] + view.totalPaddingLeft).toFloat()
    val dy = (viewAt[1] - sourceAt[1] + view.totalPaddingTop).toFloat()
    val metrics = view.paint.fontMetrics
    // The end of the last glyph: measured from its start, since the offset
    // after a line's last character belongs to the next line.
    val endX =
      layout.getPrimaryHorizontal(end - 1) + view.paint.measureText(string, end - 1, end)
    val firstLine = layout.getLineForOffset(start)
    val lastLine = layout.getLineForOffset(end - 1)
    val rects = mutableListOf<Double>()
    for (line in firstLine..lastLine) {
      val left = if (line == firstLine) layout.getPrimaryHorizontal(start) else layout.getLineLeft(line)
      val right = if (line == lastLine) endX else layout.getLineRight(line)
      val baseline = layout.getLineBaseline(line).toFloat()
      val top = baseline + metrics.ascent
      rects += listOf(
        ((dx + left) / density).toDouble(),
        ((dy + top) / density).toDouble(),
        ((right - left) / density).toDouble(),
        ((metrics.descent - metrics.ascent) / density).toDouble(),
      )
    }
    val top = layout.getLineBaseline(lastLine) + metrics.ascent
    return mapOf(
      "x" to ((dx + endX) / density).toDouble(),
      "top" to ((dy + top) / density).toDouble(),
      "rects" to rects,
    )
  }

  private fun collect(view: View, into: MutableList<TextView>) {
    if (view.visibility != View.VISIBLE) return
    if (view is TextView) {
      into += view
      return
    }
    if (view is ViewGroup) for (index in 0 until view.childCount) collect(view.getChildAt(index), into)
  }

  private fun commonSuffix(a: String, b: String): Int {
    var count = 0
    while (count < a.length && count < b.length && a[a.length - 1 - count] == b[b.length - 1 - count]) count++
    return count
  }

  private fun commonPrefix(a: String, b: String): Int {
    var count = 0
    while (count < a.length && count < b.length && a[count] == b[count]) count++
    return count
  }
}

/**
 * Watches the activity's window callback for the floating text-selection menu
 * a selectable text view starts. For a timeline source it attaches Add note
 * through the view's own custom selection callback, which the system menu
 * consults while it builds its items (the window callback cannot change that
 * menu itself: the system builds floating menus from its own copy of the
 * callback). Every call still goes to the original callback unchanged.
 */
internal class AnnotationWindowCallback(
  private val base: Window.Callback,
  private val activity: Activity,
) : Window.Callback by base {
  override fun onWindowStartingActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
    if (type == ActionMode.TYPE_FLOATING) attach()
    return base.onWindowStartingActionMode(callback, type)
  }

  override fun onWindowStartingActionMode(callback: ActionMode.Callback): ActionMode? =
    base.onWindowStartingActionMode(callback)

  private fun attach() {
    val title = TextSelectionState.title ?: return
    if (TextSelectionState.emit == null) return
    // A read-only selectable text view rarely takes focus: find the text view
    // that holds the selection this menu is for.
    val selected =
      (activity.currentFocus as? TextView)?.takeIf { it.isTextSelectable && it.hasSelection() }
        ?: activity.window?.decorView?.let(::selectedTextView)
        ?: return
    val key = TextSelectionState.sourceKey(selected)
    if (key.isNullOrEmpty()) return
    val current = selected.customSelectionActionModeCallback
    val previous = if (current is AnnotateCallback) current.previous else current
    selected.customSelectionActionModeCallback = AnnotateCallback(previous, selected, key, title)
  }

  private fun selectedTextView(view: View): TextView? {
    if (view.visibility != View.VISIBLE) return null
    if (view is TextView) return view.takeIf { it.isTextSelectable && it.hasSelection() }
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      selectedTextView(view.getChildAt(index))?.let { return it }
    }
    return null
  }
}

/**
 * Adds Add note to a text view's selection menu, ahead of the system items,
 * and reports the selection with its surroundings when it is chosen. Any
 * custom callback the view already had keeps running.
 */
private class AnnotateCallback(
  val previous: ActionMode.Callback?,
  private val view: TextView,
  private val sourceKey: String,
  private val title: String,
) : ActionMode.Callback {
  override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
    if (previous?.onCreateActionMode(mode, menu) == false) return false
    if (menu.findItem(ITEM_ID) == null) {
      menu.add(Menu.NONE, ITEM_ID, 0, title).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
    }
    return true
  }

  override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean =
    previous?.onPrepareActionMode(mode, menu) ?: false

  override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
    if (item.itemId != ITEM_ID) return previous?.onActionItemClicked(mode, item) ?: false
    val text = view.text
    val start = minOf(view.selectionStart, view.selectionEnd)
    val end = maxOf(view.selectionStart, view.selectionEnd)
    if (start < 0 || end <= start || end > text.length) return true
    TextSelectionState.emit?.invoke(
      mapOf(
        "sourceKey" to sourceKey,
        "quote" to text.subSequence(start, end).toString(),
        "before" to text.subSequence(0, start).toString(),
        "after" to text.subSequence(end, text.length).toString(),
      ),
    )
    view.performHapticFeedback(
      if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM
      else HapticFeedbackConstants.VIRTUAL_KEY,
    )
    mode.finish()
    (view.text as? Spannable)?.let { Selection.removeSelection(it) }
    return true
  }

  override fun onDestroyActionMode(mode: ActionMode) {
    previous?.onDestroyActionMode(mode)
  }

  private companion object {
    const val ITEM_ID = 0x4f47414e
  }
}
