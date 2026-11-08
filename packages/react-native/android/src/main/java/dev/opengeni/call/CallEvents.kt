package dev.opengeni.call

/** Events to JavaScript: set while the module observes them, null otherwise. */
internal object CallEvents {
  @Volatile var emit: ((Map<String, Any?>) -> Unit)? = null

  fun send(event: Map<String, Any?>) {
    emit?.invoke(event)
  }

  /** Whether JavaScript is listening right now. */
  val listening: Boolean
    get() = emit != null
}
