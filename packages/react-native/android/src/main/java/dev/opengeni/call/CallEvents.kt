package dev.opengeni.call

import android.os.SystemClock
import java.util.UUID

/** Events to JavaScript: set while the module observes them, null otherwise. */
internal object CallEvents {
  /** A request nobody took this long after it was made is stale. */
  private const val START_REQUEST_LIFETIME_MS = 60_000L

  @Volatile var emit: ((Map<String, Any?>) -> Unit)? = null

  private var pendingStart: Pair<Map<String, Any?>, Long>? = null

  fun send(event: Map<String, Any?>) {
    emit?.invoke(event)
  }

  /** Whether JavaScript is listening right now. */
  val listening: Boolean
    get() = emit != null

  /**
   * Ask JavaScript to start a call into `target` (a session) in `workspaceId`.
   * The request waits until JavaScript takes it ([takePendingStart]), since the
   * module observing events does not mean the code that starts calls listens.
   */
  fun requestStart(target: String?, workspaceId: String?) {
    val event =
      mapOf(
        "type" to "startRequested",
        "target" to target,
        "workspaceId" to if (target == null) null else workspaceId,
        "requestId" to UUID.randomUUID().toString(),
      )
    synchronized(this) { pendingStart = event to SystemClock.elapsedRealtime() }
    emit?.invoke(event)
  }

  /** The waiting start request, once; null when there is none or it went stale. */
  @Synchronized
  fun takePendingStart(): Map<String, Any?>? {
    val (event, at) = pendingStart ?: return null
    pendingStart = null
    if (SystemClock.elapsedRealtime() - at > START_REQUEST_LIFETIME_MS) return null
    return mapOf(
      "target" to event["target"],
      "workspaceId" to event["workspaceId"],
      "requestId" to event["requestId"],
    )
  }
}
