package dev.opengeni.foreground

/**
 * When a foreground service may start and stop without Android killing the app.
 *
 * A service started with startForegroundService() owes Android a call to
 * startForeground(). Stopping it before that (stopService(), stopSelf()) makes
 * Android 8 and later kill the whole app with "Context.startForegroundService()
 * did not then call Service.startForeground()". So:
 *
 * - A start prefers startService(), which owes Android nothing. It works while
 *   the app is in the foreground or already has a foreground service. Only
 *   when Android refuses it (the app is in the background) does a start go
 *   through startForegroundService() and owe a startForeground().
 * - The service always calls startForeground() before anything else for an
 *   owed start, and reports each start it handled.
 * - A stop while a start is still owed only records that the service is no
 *   longer wanted. The service stops itself once it has handled every owed
 *   start.
 *
 * Every decision runs under one lock together with the start or stop it leads
 * to, so a start on another thread cannot slip in between deciding to stop and
 * stopping. None of the calls made under the lock wait for the main thread,
 * where the service handles its starts.
 *
 * Plain Kotlin, so its rules are tested on the JVM against a model of Android.
 */
class ForegroundStarts {
  private val lock = Any()
  private var wanted = false
  private var owed = 0

  /**
   * Start the service, or update it while it runs. [startService] is
   * Context.startService() and [startForegroundService] is
   * Context.startForegroundService() with its intent marked as owed; each
   * returns whether Android started the service. Pass null for
   * [startForegroundService] when the service could not settle an owed start.
   * Returns false when Android allowed neither start.
   */
  fun start(startService: () -> Boolean, startForegroundService: (() -> Boolean)?): Boolean =
    synchronized(lock) {
      wanted = true
      if (attempt(startService)) return true
      if (startForegroundService == null) return false
      // Counted before the call: the service may handle the start before the call returns.
      owed += 1
      if (attempt(startForegroundService)) return true
      owed -= 1
      false
    }

  /** No longer needed: stop now, or once the service has handled every owed start. */
  fun stop(stopService: () -> Unit) {
    synchronized(lock) {
      wanted = false
      if (owed == 0) stopService()
    }
  }

  /**
   * The service handled a start: [owedStart] when it came through
   * startForegroundService(), in which case startForeground() has already
   * been called, and [inForeground] when the service is now in the
   * foreground. Calls [stopSelf] when the service has no reason left to run
   * and stopping it is safe.
   */
  fun handled(owedStart: Boolean, inForeground: Boolean, stopSelf: () -> Unit) {
    synchronized(lock) {
      // A fresh process (the old one died with a start pending) has counted nothing.
      if (owedStart && owed > 0) owed -= 1
      if (owed > 0) return
      if (wanted && inForeground) return
      stopSelf()
    }
  }

  private fun attempt(start: () -> Boolean): Boolean =
    try {
      start()
    } catch (_: Exception) {
      false
    }
}
