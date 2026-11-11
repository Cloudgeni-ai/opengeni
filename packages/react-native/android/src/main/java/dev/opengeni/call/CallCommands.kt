package dev.opengeni.call

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.opengeni.textselection.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * Voice commands on Android: each chat the person picked in the app becomes a
 * launcher shortcut (long-press the app icon, or pinned to the home screen)
 * that starts a call straight into that chat, through the same start request
 * as on iOS. Launcher shortcuts only run on an unlocked phone.
 *
 * The app writes the signed-in account's commands (none while signed out).
 * Pinned shortcuts cannot be removed by an app, so those of commands that no
 * longer exist (removed, or another account's) are disabled, and enabled
 * again when their command comes back.
 */
internal object CallCommands {
  const val ACTION_START = "dev.opengeni.call.START_COMMAND"
  private const val EXTRA_COMMAND = "dev.opengeni.call.COMMAND_ID"
  private const val PREFERENCES = "dev.opengeni.call.commands"
  private const val KEY = "commands.v1"
  private const val ID_PREFIX = "opengeni-call:"

  data class Command(
    val id: String,
    val workspaceId: String,
    val sessionId: String,
    val name: String,
  )

  /** A command as JavaScript sends it, or null when a field is missing. */
  fun parse(raw: Map<String, Any?>): Command? {
    fun text(key: String) = (raw[key] as? String)?.trim()?.takeIf { it.isNotEmpty() }
    return Command(
      id = text("id") ?: return null,
      workspaceId = text("workspaceId") ?: return null,
      sessionId = text("sessionId") ?: return null,
      name = text("name") ?: return null,
    )
  }

  fun all(context: Context): List<Command> {
    val raw = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY, null)
      ?: return emptyList()
    return try {
      val array = JSONArray(raw)
      (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        parse(
          mapOf(
            "id" to item.optString("id"),
            "workspaceId" to item.optString("workspaceId"),
            "sessionId" to item.optString("sessionId"),
            "name" to item.optString("name"),
          ))
      }
    } catch (_: Exception) {
      emptyList()
    }
  }

  /** Store the commands and bring the launcher's shortcuts in line with them. */
  fun replace(context: Context, commands: List<Command>) {
    val array = JSONArray()
    for (command in commands) {
      array.put(
        JSONObject()
          .put("id", command.id)
          .put("workspaceId", command.workspaceId)
          .put("sessionId", command.sessionId)
          .put("name", command.name))
    }
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(KEY, array.toString()).apply()

    // The launcher shows only the first few; the first created come first.
    val limit = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context).coerceAtLeast(0)
    val shortcuts = commands.mapIndexed { rank, command -> shortcut(context, command, rank) }
    try {
      ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts.take(limit))
      val current = commands.map { shortcutId(it.id) }.toSet()
      val pinned =
        ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)
          .map { it.id }
          .filter { it.startsWith(ID_PREFIX) }
      val gone = pinned.filter { it !in current }
      if (gone.isNotEmpty()) {
        ShortcutManagerCompat.disableShortcuts(context, gone, "This voice command was removed.")
      }
      val kept = pinned.filter { it in current }
      if (kept.isNotEmpty()) {
        ShortcutManagerCompat.enableShortcuts(context, shortcuts.filter { it.id in kept })
        ShortcutManagerCompat.updateShortcuts(context, shortcuts.filter { it.id in kept })
      }
    } catch (error: Exception) {
      // Rate limits or a launcher without shortcuts: the commands stay stored.
      android.util.Log.w("OpenGeniCall", "Couldn't update call shortcuts.", error)
    }
  }

  /** Ask the launcher to pin a command's shortcut; false when it can't. */
  fun pin(context: Context, command: Command): Boolean {
    if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) return false
    val rank = all(context).indexOfFirst { it.id == command.id }.coerceAtLeast(0)
    return ShortcutManagerCompat.requestPinShortcut(context, shortcut(context, command, rank), null)
  }

  /**
   * A launch from a command's shortcut becomes a start request for its chat,
   * once: the intent is marked handled so a recreated activity does not call
   * again. A command that no longer exists only opens the app.
   */
  fun handle(context: Context, intent: Intent?): Boolean {
    if (intent?.action != ACTION_START) return false
    val id = intent.getStringExtra(EXTRA_COMMAND)
    intent.action = Intent.ACTION_MAIN
    val command = id?.let { wanted -> all(context).firstOrNull { it.id == wanted } } ?: return true
    CallEvents.requestStart(command.sessionId, command.workspaceId)
    return true
  }

  private fun shortcutId(commandId: String) = "$ID_PREFIX$commandId"

  private fun shortcut(context: Context, command: Command, rank: Int): ShortcutInfoCompat {
    val launcher = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component
      ?: ComponentName(context.packageName, "${context.packageName}.MainActivity")
    val intent =
      Intent(ACTION_START)
        .setComponent(launcher)
        .putExtra(EXTRA_COMMAND, command.id)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return ShortcutInfoCompat.Builder(context, shortcutId(command.id))
      .setShortLabel(command.name)
      .setLongLabel("Call ${command.name}")
      .setIcon(IconCompat.createWithResource(context, R.drawable.opengeni_call_shortcut))
      .setIntent(intent)
      .setRank(rank)
      .build()
  }
}
