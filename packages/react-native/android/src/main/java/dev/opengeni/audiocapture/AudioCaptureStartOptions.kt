package dev.opengeni.audiocapture

/**
 * Options JavaScript passes to `start` (see `NativeAudioCapture` in src/recordings).
 *
 * Read by hand from the plain object rather than as an Expo `Record`: Expo
 * converts a `Record` by Kotlin reflection, and an app's release build with
 * R8 optimization breaks that conversion, so every start failed before the
 * microphone was even opened.
 */
class AudioCaptureStartOptions(
  val recordingId: String = "",
  val directory: String = "",
  val trackNumber: Int = 0,
  val chunkMilliseconds: Int = 5_000,
  val bitRate: Int = 64_000,
  val notificationTitle: String = "",
  val notificationText: String = "",
) {
  companion object {
    fun from(values: Map<String, Any?>): AudioCaptureStartOptions =
      AudioCaptureStartOptions(
        recordingId = values.text("recordingId") ?: "",
        directory = values.text("directory") ?: "",
        trackNumber = values.integer("trackNumber") ?: 0,
        chunkMilliseconds = values.integer("chunkMilliseconds") ?: 5_000,
        bitRate = values.integer("bitRate") ?: 64_000,
        notificationTitle = values.text("notificationTitle") ?: "",
        notificationText = values.text("notificationText") ?: "",
      )

    private fun Map<String, Any?>.text(key: String): String? = this[key] as? String

    // JavaScript numbers arrive as doubles.
    private fun Map<String, Any?>.integer(key: String): Int? = (this[key] as? Number)?.toInt()
  }
}
