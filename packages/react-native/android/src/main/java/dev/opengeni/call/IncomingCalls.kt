package dev.opengeni.call

/**
 * Agents' calls to this phone, from their ring to their answer, kept until
 * JavaScript takes them: a ring can start the app, and the person can answer
 * before JavaScript runs. The same contract as the iOS call center.
 */
internal object IncomingCalls {
  data class Call(
    val id: String,
    val sessionId: String,
    val workspaceId: String,
    val subjectId: String?,
    val title: String?,
    val reason: String?,
    val ringUntil: String?,
    /** "ringing", then "answered" or "declined" by the person on this phone. */
    var state: String = "ringing",
    /** Whether JavaScript has seen this call in its current state. */
    var delivered: Boolean = false,
  ) {
    fun event(type: String): Map<String, Any?> =
      buildMap {
        put("type", type)
        put("callId", id)
        put("sessionId", sessionId)
        put("workspaceId", workspaceId)
        put("state", state)
        subjectId?.let { put("subjectId", it) }
        title?.let { put("title", it) }
        reason?.let { put("reason", it) }
        ringUntil?.let { put("ringUntil", it) }
      }
  }

  private val calls = LinkedHashMap<String, Call>()

  @Synchronized
  fun get(id: String): Call? = calls[id.lowercase()]

  @Synchronized
  fun ringing(call: Call) {
    calls[call.id] = call
    deliver(call, "incoming")
  }

  @Synchronized
  fun answered(id: String) {
    val call = calls[id.lowercase()] ?: return
    call.state = "answered"
    deliver(call, "incomingAnswered")
  }

  @Synchronized
  fun declined(id: String) {
    val call = calls[id.lowercase()] ?: return
    call.state = "declined"
    deliver(call, "incomingDeclined")
  }

  /** It rang out on this phone. */
  @Synchronized
  fun rangOut(id: String) {
    calls.remove(id.lowercase()) ?: return
    CallEvents.send(mapOf("type" to "incomingEnded", "callId" to id.lowercase(), "reason" to "unanswered"))
  }

  @Synchronized
  fun remove(id: String) {
    calls.remove(id.lowercase())
  }

  /**
   * Calls JavaScript should act on: every ringing call (watching one twice is
   * harmless), and each answer or decline it has not seen yet, exactly once.
   */
  @Synchronized
  fun take(): List<Map<String, Any?>> {
    val taken = mutableListOf<Map<String, Any?>>()
    val iterator = calls.values.iterator()
    while (iterator.hasNext()) {
      val call = iterator.next()
      if (call.state == "ringing") {
        taken.add(call.event("incoming"))
      } else if (!call.delivered) {
        taken.add(call.event("incoming"))
        call.delivered = true
      }
      if (call.state == "declined") iterator.remove()
    }
    return taken
  }

  private fun deliver(call: Call, type: String) {
    call.delivered = CallEvents.listening
    CallEvents.send(call.event(type))
  }
}
