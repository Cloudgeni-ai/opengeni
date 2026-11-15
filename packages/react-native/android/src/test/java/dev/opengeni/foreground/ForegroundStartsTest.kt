package dev.opengeni.foreground

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ForegroundStarts] against a model of how Android (ActiveServices) treats a
 * started service, trying every short sequence of starts, stops, handled
 * starts and the app moving between the foreground and the background.
 *
 * Run from an app that links the package: `./gradlew :opengeni_react-native:testDebugUnitTest`.
 */
class ForegroundStartsTest {
  /**
   * One service as Android sees it. Stricter than Android where that is
   * simpler: only startForeground() settles an owed start (Android 11 also
   * lets a later startService() settle it). With [startIdGuard] false,
   * stopSelf(startId) stops even when a newer start is on its way, so the
   * owed count is tested without Android's own guard.
   */
  private class Android(val sdk: Int, val startIdGuard: Boolean = true) {
    var appInForeground = true
    var running = false
    var owesForeground = false
    var foreground = false
    var lastStartId = 0
    val pending = ArrayDeque<Pair<Boolean, Int>>()
    var crash: String? = null

    fun startService(): Boolean {
      // Android 8: no starting services from the background, unless the app is in the foreground
      // by way of a foreground service.
      if (!appInForeground && !foreground) throw IllegalStateException("app is in background")
      return begin(owed = false)
    }

    fun startForegroundService(): Boolean {
      // Android 12: no foreground services started from the background.
      if (!appInForeground && sdk >= 31) throw IllegalStateException("not allowed")
      return begin(owed = true)
    }

    private fun begin(owed: Boolean): Boolean {
      running = true
      if (owed) owesForeground = true
      lastStartId += 1
      pending.addLast(owed to lastStartId)
      return true
    }

    fun stopService() {
      if (running) bringDown()
    }

    fun stopSelf(startId: Int) {
      if (running && (startId == lastStartId || !startIdGuard)) bringDown()
    }

    private fun bringDown() {
      if (owesForeground) {
        crash = "Context.startForegroundService() did not then call Service.startForeground()"
      }
      running = false
      owesForeground = false
      foreground = false
      pending.clear()
    }

    /**
     * The service's onStartCommand() for the next start. startForeground()
     * settles an owed start even when it is refused: the startForeground()
     * failures that would not are ruled out before any owed start.
     */
    fun deliver(starts: ForegroundStarts, allowed: Boolean) {
      val (owed, startId) = pending.removeFirstOrNull() ?: return
      owesForeground = false
      if (allowed) foreground = true
      starts.handled(owed, foreground) { stopSelf(startId) }
    }
  }

  private enum class Step { START, STOP, HANDLE, HANDLE_REFUSED, BACKGROUND, FOREGROUND }

  private fun run(sdk: Int, startIdGuard: Boolean, steps: List<Step>): String? {
    val android = Android(sdk, startIdGuard)
    val starts = ForegroundStarts()
    var wanted = false
    for (step in steps) {
      when (step) {
        Step.START -> {
          wanted = true
          starts.start(android::startService, android::startForegroundService)
        }
        Step.STOP -> {
          wanted = false
          starts.stop(android::stopService)
        }
        Step.HANDLE -> android.deliver(starts, allowed = true)
        Step.HANDLE_REFUSED -> android.deliver(starts, allowed = false)
        Step.BACKGROUND -> android.appInForeground = false
        Step.FOREGROUND -> android.appInForeground = true
      }
      android.crash?.let { return "$it after $steps" }
    }
    while (android.pending.isNotEmpty()) {
      android.deliver(starts, allowed = true)
      android.crash?.let { return "$it after $steps and its starts" }
    }
    // Nothing lingers once stopped; a running service is in the foreground.
    if (!wanted && android.running) return "still running after $steps"
    if (android.running && !android.foreground) return "running outside the foreground after $steps"
    return null
  }

  private fun sequences(length: Int): Sequence<List<Step>> =
    if (length == 0) sequenceOf(emptyList())
    else sequences(length - 1).flatMap { prefix -> Step.values().asSequence().map { prefix + it } }

  @Test
  fun noSequenceCrashesTheAppOrLeavesTheServiceBehind() {
    for (sdk in listOf(26, 30, 31, 34)) {
      for (startIdGuard in listOf(true, false)) {
        for (length in 1..7) {
          for (steps in sequences(length)) assertNull(run(sdk, startIdGuard, steps))
        }
      }
    }
  }

  @Test
  fun theModelCatchesTheCrashOfStoppingBeforeStartForeground() {
    // Starting with startForegroundService() and stopping straight away, as before.
    val android = Android(30)
    android.startForegroundService()
    android.stopService()
    assertTrue(android.crash != null)
  }

  @Test
  fun aStopWhileAStartIsOwedWaitsForTheService() {
    val android = Android(30)
    val starts = ForegroundStarts()
    android.appInForeground = false
    assertTrue(starts.start(android::startService, android::startForegroundService))
    starts.stop(android::stopService)
    assertTrue(android.running)
    android.deliver(starts, allowed = false)
    assertNull(android.crash)
    assertFalse(android.running)
  }

  @Test
  fun theForegroundAppOwesNothing() {
    val android = Android(34)
    val starts = ForegroundStarts()
    assertTrue(starts.start(android::startService, android::startForegroundService))
    assertFalse(android.owesForeground)
    starts.stop(android::stopService)
    assertNull(android.crash)
    assertFalse(android.running)
  }

  @Test
  fun aRefusedStartReportsFalse() {
    val android = Android(34)
    val starts = ForegroundStarts()
    android.appInForeground = false
    assertFalse(starts.start(android::startService, android::startForegroundService))
    assertFalse(starts.start(android::startService, null))
    assertEquals(0, android.lastStartId)
    starts.stop(android::stopService)
    assertNull(android.crash)
  }
}

