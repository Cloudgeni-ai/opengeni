package dev.opengeni.audiocapture

import org.junit.Assert.assertEquals
import org.junit.Test

/** Run from an app that links the package: `./gradlew :opengeni_react-native:testDebugUnitTest`. */
class AudioCaptureStartOptionsTest {
  @Test
  fun readsWhatJavaScriptSends() {
    // As Expo hands over a JavaScript object: numbers as doubles.
    val options =
      AudioCaptureStartOptions.from(
        mapOf(
          "recordingId" to "recording-1",
          "directory" to "file:///data/user/0/app/files/opengeni-recordings/recording-1",
          "trackNumber" to 1.0,
          "chunkMilliseconds" to 5_000.0,
          "bitRate" to 32_000.0,
          "notificationTitle" to "Recording",
          "notificationText" to "Tap to return",
        ))
    assertEquals("recording-1", options.recordingId)
    assertEquals("file:///data/user/0/app/files/opengeni-recordings/recording-1", options.directory)
    assertEquals(1, options.trackNumber)
    assertEquals(5_000, options.chunkMilliseconds)
    assertEquals(32_000, options.bitRate)
    assertEquals("Recording", options.notificationTitle)
    assertEquals("Tap to return", options.notificationText)
  }

  @Test
  fun keepsDefaultsForMissingOrMistypedValues() {
    val options =
      AudioCaptureStartOptions.from(mapOf("recordingId" to "recording-2", "bitRate" to "fast", "trackNumber" to null))
    assertEquals("recording-2", options.recordingId)
    assertEquals("", options.directory)
    assertEquals(0, options.trackNumber)
    assertEquals(5_000, options.chunkMilliseconds)
    assertEquals(64_000, options.bitRate)
  }
}
