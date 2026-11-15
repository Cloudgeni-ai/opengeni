package dev.opengeni.audiocapture

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import dev.opengeni.foreground.ForegroundService
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** One capture at a time, shared across JavaScript reloads. */
object AudioCapture {
  private const val SAMPLE_RATE = 48_000
  private const val SAMPLES_PER_FRAME = 1_024L
  private const val MIME = MediaFormat.MIMETYPE_AUDIO_AAC
  // The live transcript's copy of the audio: 16 kHz 16-bit PCM in blocks of a tenth of a second.
  private const val LIVE_SAMPLE_RATE = 16_000
  private const val LIVE_RATIO = SAMPLE_RATE / LIVE_SAMPLE_RATE
  private const val LIVE_BLOCK_SAMPLES = LIVE_SAMPLE_RATE / 10

  @Volatile var emit: ((String, Map<String, Any?>) -> Unit)? = null

  /** The foreground service that keeps capture going in the background. */
  val service = ForegroundService(OpenGeniAudioCaptureService::class.java)

  private val lock = Object()
  private var options = AudioCaptureStartOptions()
  private var directory: File? = null
  @Volatile private var active: String? = null
  @Volatile private var pausedByPerson = false
  @Volatile private var silenced = false
  @Volatile private var running = false
  @Volatile private var currentLevel = 0.0
  @Volatile private var samplesFed = 0L

  private var appContext: Context? = null
  private var record: AudioRecord? = null
  private var codec: MediaCodec? = null
  private var thread: Thread? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private var lastChunk: Map<String, Any?>? = null

  // The chunk being written, touched only by the capture thread (and by stop after it ends).
  private var samplesEncoded = 0L
  private var chunkNumber = 0
  private var chunkStartSamples = 0L
  private var chunkSamples = 0L
  private var chunkBytes = 0
  private var chunkPart: File? = null
  private var chunkStream: FileOutputStream? = null

  // Touched only by the capture thread, except that setLivePcm flips the flag.
  @Volatile private var livePcm = false
  @Volatile private var liveReset = false
  private val liveCarry = IntArray(LIVE_RATIO)
  private var liveCarryCount = 0
  private val liveBlock =
    ByteBuffer.allocate(LIVE_BLOCK_SAMPLES * 2).order(ByteOrder.LITTLE_ENDIAN)
  private var liveBlockStartMilliseconds = 0.0

  fun recordingId(): String? = active

  /** Start or stop sending the live transcript's copy of the audio as `onPcm`. */
  fun setLivePcm(enabled: Boolean) {
    livePcm = enabled
    liveReset = true
  }

  fun level(): Double = if (active == null || pausedByPerson || silenced) 0.0 else currentLevel

  fun elapsedMilliseconds(): Double = samplesFed * 1_000.0 / SAMPLE_RATE

  @SuppressLint("MissingPermission")
  fun start(context: Context, options: AudioCaptureStartOptions): Map<String, Any?> {
    synchronized(lock) {
      if (active != null) throw AudioCaptureException("Another recording is in progress.")
      this.options = options
      appContext = context
      var audio: AudioRecord? = null
      var encoder: MediaCodec? = null
      var serviceStarted = false
      try {
        val folder =
          if (options.directory.startsWith("file:")) File(Uri.parse(options.directory).path!!)
          else File(options.directory)
        folder.mkdirs()
        directory = folder

        val minimum =
          AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) throw AudioCaptureException("No microphone could be opened.")
        val opened =
          try {
            AudioRecord(
              MediaRecorder.AudioSource.MIC,
              SAMPLE_RATE,
              AudioFormat.CHANNEL_IN_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
              max(minimum, SAMPLE_RATE / 5 * 2))
          } catch (error: Exception) {
            throw AudioCaptureException("No microphone could be opened.")
          }
        audio = opened
        if (opened.state != AudioRecord.STATE_INITIALIZED) {
          throw AudioCaptureException("No microphone could be opened.")
        }
        val format =
          MediaFormat.createAudioFormat(MIME, SAMPLE_RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, options.bitRate.coerceIn(24_000, 192_000))
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
          }
        val created =
          try {
            MediaCodec.createEncoderByType(MIME).also {
              encoder = it
              it.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
              it.start()
            }
          } catch (error: Exception) {
            throw AudioCaptureException("The audio encoder could not start.")
          }

        // Foreground first: Android only lets a foreground service keep the microphone in the
        // background. Without it, recording goes on while the app is open.
        serviceStarted = true
        if (!service.start(context, serviceIntent(options))) reportForegroundUnavailable("")
        try {
          opened.startRecording()
        } catch (error: Exception) {
          throw AudioCaptureException("No microphone could be opened.")
        }

        samplesFed = 0
        livePcm = false
        liveReset = true
        samplesEncoded = 0
        chunkNumber = 0
        pausedByPerson = false
        silenced = false
        lastChunk = null
        try {
          openChunk()
        } catch (error: Exception) {
          throw AudioCaptureException("The recording could not be saved.")
        }
        watchSilencing(context, opened)
        record = opened
        codec = created
      } catch (error: Exception) {
        // Nothing stays open: the microphone, the encoder, the chunk file and the service.
        unwatchSilencing()
        discardChunk()
        quietly { encoder?.stop() }
        quietly { encoder?.release() }
        quietly { audio?.release() }
        if (serviceStarted) service.stop(context)
        throw error as? AudioCaptureException
          ?: AudioCaptureException("Recording could not start. ${error.message ?: ""}".trim())
      }
      val started = record!!
      val startedEncoder = codec!!
      active = options.recordingId
      running = true
      thread =
        Thread({ loop(started, startedEncoder) }, "opengeni-audio-capture").also { it.start() }
      val device = started.routedDevice?.productName?.toString()
      return mapOf("sampleRate" to SAMPLE_RATE, "inputName" to (device ?: ""))
    }
  }

  fun pause() {
    if (active == null || pausedByPerson) return
    pausedByPerson = true
    try {
      record?.stop()
    } catch (_: Exception) {}
  }

  fun resume() {
    if (active == null) throw AudioCaptureException("Nothing is being recorded.")
    if (!pausedByPerson) return
    try {
      record?.startRecording()
    } catch (error: Exception) {
      throw AudioCaptureException("The microphone could not start again.")
    }
    pausedByPerson = false
    synchronized(lock) { lock.notifyAll() }
  }

  /** Stop capture; returns the final chunk, or null when there was none or when cancelled. */
  fun stop(cancel: Boolean): Map<String, Any?>? {
    val id: String
    synchronized(lock) {
      id = active ?: return null
      running = false
      lock.notifyAll()
    }
    try {
      record?.stop()
    } catch (_: Exception) {}
    var last: Map<String, Any?>? = null
    try {
      thread?.join(10_000)
      thread = null
      val encoder = codec
      if (cancel) {
        discardChunk()
      } else if (encoder != null) {
        drain(encoder, endOfStream = true)
        last = closeChunk(emitEvent = true)
      }
    } finally {
      // Whatever finishing the last chunk did, the microphone and the service are let go.
      // An unfinished chunk file stays for recovery.
      quietly { chunkStream?.close() }
      chunkStream = null
      chunkPart = null
      quietly { codec?.stop() }
      quietly { codec?.release() }
      codec = null
      quietly { record?.release() }
      record = null
      quietly { unwatchSilencing() }
      appContext?.let { service.stop(it) }
      active = null
    }
    send("onState", mapOf("recordingId" to id, "state" to "stopped"))
    return last
  }

  // --- Capture loop ---------------------------------------------------------------

  private fun loop(audio: AudioRecord, encoder: MediaCodec) {
    try {
      capture(audio, encoder)
    } catch (error: Exception) {
      // An exception here would end the app: report it, and stop() still finishes the recording.
      if (!running) return
      active?.let {
        send(
          "onError",
          mapOf(
            "recordingId" to it,
            "code" to "capture_failed",
            "message" to "Recording stopped unexpectedly. ${error.message ?: ""}".trim()))
      }
    }
  }

  private fun capture(audio: AudioRecord, encoder: MediaCodec) {
    val buffer = ShortArray(SAMPLE_RATE / 10)
    var presentationUs = 0L
    while (running) {
      if (pausedByPerson) {
        synchronized(lock) { if (running && pausedByPerson) lock.wait(250) }
        continue
      }
      val read = audio.read(buffer, 0, buffer.size)
      if (read <= 0) {
        if (read < 0 && running && !pausedByPerson) {
          active?.let {
            send(
              "onError",
              mapOf(
                "recordingId" to it,
                "code" to "capture_failed",
                "message" to "The microphone stopped delivering audio ($read)."))
          }
          Thread.sleep(100)
        }
        continue
      }
      // While another app or a call holds the microphone, Android delivers silence: leave it out.
      if (silenced) continue
      var sum = 0.0
      for (index in 0 until read) {
        val sample = buffer[index] / 32_768.0
        sum += sample * sample
      }
      currentLevel = min(1.0, sqrt(sum / read) * 4)
      if (liveReset) {
        liveReset = false
        liveCarryCount = 0
        liveBlock.clear()
      }
      if (livePcm) tapLive(buffer, read, samplesFed)
      var offset = 0
      while (offset < read) {
        val inputIndex = encoder.dequeueInputBuffer(10_000)
        if (inputIndex < 0) {
          drain(encoder, endOfStream = false)
          continue
        }
        val input = encoder.getInputBuffer(inputIndex)!!
        input.clear()
        val samples = min(read - offset, input.capacity() / 2)
        for (index in 0 until samples) input.putShort(buffer[offset + index])
        encoder.queueInputBuffer(inputIndex, 0, samples * 2, presentationUs, 0)
        presentationUs += samples * 1_000_000L / SAMPLE_RATE
        offset += samples
        samplesFed += samples
      }
      drain(encoder, endOfStream = false)
    }
  }

  /**
   * Average each three 48 kHz samples into one 16 kHz sample (enough of a
   * low-pass for speech) and send whole blocks with where they start in the
   * recording, excluding pauses.
   */
  private fun tapLive(buffer: ShortArray, read: Int, startSample: Long) {
    val id = active ?: return
    if (liveBlock.position() == 0) {
      liveBlockStartMilliseconds = (startSample - liveCarryCount) * 1_000.0 / SAMPLE_RATE
    }
    for (index in 0 until read) {
      liveCarry[liveCarryCount++] = buffer[index].toInt()
      if (liveCarryCount < LIVE_RATIO) continue
      liveCarryCount = 0
      liveBlock.putShort((liveCarry.sum() / LIVE_RATIO).toShort())
      if (liveBlock.position() < liveBlock.capacity()) continue
      send(
        "onPcm",
        mapOf(
          "recordingId" to id,
          "data" to Base64.encodeToString(liveBlock.array(), 0, liveBlock.position(), Base64.NO_WRAP),
          "sampleRate" to LIVE_SAMPLE_RATE,
          "recordedMilliseconds" to liveBlockStartMilliseconds))
      liveBlock.clear()
      liveBlockStartMilliseconds = (startSample + index + 1) * 1_000.0 / SAMPLE_RATE
    }
  }

  private fun drain(encoder: MediaCodec, endOfStream: Boolean) {
    if (endOfStream) {
      val inputIndex = encoder.dequeueInputBuffer(100_000)
      if (inputIndex >= 0) {
        encoder.queueInputBuffer(
          inputIndex, 0, 0, samplesFed * 1_000_000L / SAMPLE_RATE,
          MediaCodec.BUFFER_FLAG_END_OF_STREAM)
      }
    }
    val info = MediaCodec.BufferInfo()
    while (true) {
      val outputIndex = encoder.dequeueOutputBuffer(info, if (endOfStream) 100_000 else 0)
      if (outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
        if (endOfStream) continue else return
      }
      if (outputIndex < 0) continue
      val output = encoder.getOutputBuffer(outputIndex)
      val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
      if (output != null && info.size > 0 && !config) {
        val frame = ByteArray(info.size + 7)
        writeAdtsHeader(frame, info.size)
        output.position(info.offset)
        output.get(frame, 7, info.size)
        write(frame)
      }
      encoder.releaseOutputBuffer(outputIndex, false)
      if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
    }
  }

  /** The 7-byte ADTS header for one AAC-LC frame at 48 kHz, mono, without CRC. */
  private fun writeAdtsHeader(frame: ByteArray, payload: Int) {
    val length = payload + 7
    val profile = 1 // AAC LC (object type 2) minus one
    val frequencyIndex = 3 // 48 kHz
    val channels = 1
    frame[0] = 0xFF.toByte()
    frame[1] = 0xF1.toByte()
    frame[2] = ((profile shl 6) or (frequencyIndex shl 2) or (channels shr 2)).toByte()
    frame[3] = (((channels and 3) shl 6) or ((length shr 11) and 0x03)).toByte()
    frame[4] = ((length shr 3) and 0xFF).toByte()
    frame[5] = (((length and 7) shl 5) or 0x1F).toByte()
    frame[6] = 0xFC.toByte()
  }

  private fun write(frame: ByteArray) {
    chunkStream?.write(frame)
    chunkBytes += frame.size
    samplesEncoded += SAMPLES_PER_FRAME
    chunkSamples += SAMPLES_PER_FRAME
    if (chunkSamples >= options.chunkMilliseconds.toLong() * SAMPLE_RATE / 1_000) {
      closeChunk(emitEvent = true)
      openChunk()
    }
  }

  // --- Chunk files ------------------------------------------------------------------

  private fun milliseconds(samples: Long) = samples * 1_000 / SAMPLE_RATE

  private fun openChunk() {
    val folder = directory ?: return
    chunkStartSamples = samplesEncoded
    chunkSamples = 0
    chunkBytes = 0
    val name =
      String.format(Locale.ROOT,
        "t%d-c%06d-s%d.part", options.trackNumber, chunkNumber, milliseconds(chunkStartSamples))
    val part = File(folder, name)
    chunkPart = part
    chunkStream = FileOutputStream(part)
  }

  /** Finish the chunk being written: name it after its contents and report it. */
  private fun closeChunk(emitEvent: Boolean): Map<String, Any?>? {
    val part = chunkPart ?: return null
    val folder = directory ?: return null
    chunkStream?.let {
      it.flush()
      it.fd.sync()
      it.close()
    }
    chunkStream = null
    chunkPart = null
    if (chunkBytes == 0) {
      part.delete()
      return null
    }
    val bytes = part.readBytes()
    val sha =
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { String.format(Locale.ROOT, "%02x", it) }
    val start = milliseconds(chunkStartSamples)
    val duration = milliseconds(chunkSamples)
    val name =
      String.format(Locale.ROOT,
        "t%d-c%06d-s%d-d%d-b%d-%s.chunk",
        options.trackNumber, chunkNumber, start, duration, bytes.size, sha)
    val target = File(folder, name)
    target.delete()
    if (!part.renameTo(target)) return null
    val event =
      mapOf(
        "recordingId" to options.recordingId,
        "trackNumber" to options.trackNumber,
        "chunkNumber" to chunkNumber,
        "startMilliseconds" to start,
        "durationMilliseconds" to duration,
        "byteLength" to bytes.size,
        "sha256" to sha,
        "fileName" to name)
    chunkNumber += 1
    lastChunk = event
    if (emitEvent) send("onChunk", event)
    return event
  }

  private fun discardChunk() {
    try {
      chunkStream?.close()
    } catch (_: Exception) {}
    chunkStream = null
    chunkPart?.delete()
    chunkPart = null
  }

  // --- Interruptions ------------------------------------------------------------------

  private fun watchSilencing(context: Context, audio: AudioRecord) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val callback =
      object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
          val mine = configs.firstOrNull { it.clientAudioSessionId == audio.audioSessionId }
          val now = mine?.isClientSilenced ?: false
          if (now == silenced) return
          silenced = now
          val id = active ?: return
          send(
            "onState",
            mapOf("recordingId" to id, "state" to if (now) "interrupted" else "recording"))
        }
      }
    manager.registerAudioRecordingCallback(callback, Handler(Looper.getMainLooper()))
    recordingCallback = callback
  }

  private fun unwatchSilencing() {
    val callback = recordingCallback ?: return
    val manager = appContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      manager?.unregisterAudioRecordingCallback(callback)
    }
    recordingCallback = null
  }

  // --- Foreground service ---------------------------------------------------------------

  private fun serviceIntent(options: AudioCaptureStartOptions): Intent =
    Intent()
      .putExtra(OpenGeniAudioCaptureService.EXTRA_TITLE, options.notificationTitle)
      .putExtra(OpenGeniAudioCaptureService.EXTRA_TEXT, options.notificationText)

  private inline fun quietly(action: () -> Unit) {
    try {
      action()
    } catch (_: Exception) {}
  }

  /** The service could not go to the foreground: capture continues only while the app is open. */
  fun reportForegroundUnavailable(reason: String) {
    val id = active ?: options.recordingId.takeIf { it.isNotEmpty() } ?: return
    send(
      "onError",
      mapOf(
        "recordingId" to id,
        "code" to "background_unavailable",
        "message" to "Recording continues only while the app is open. $reason".trim()))
  }

  private fun send(name: String, body: Map<String, Any?>) {
    emit?.invoke(name, body)
  }
}
