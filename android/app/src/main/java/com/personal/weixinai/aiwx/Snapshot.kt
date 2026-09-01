package com.personal.weixinai.aiwx

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 原生可读的到期项快照 (M-J4)。
 *
 * WHAT IT IS: a projection — never a source of truth. `scheduled_actions`
 * (IndexedDB/SQLite, JS side) remains the single time-evolution path (铁律 5).
 * Every foreground pass the JS side re-derives the next 24h of NOTIFIABLE
 * items and overwrites this file wholesale. Nothing here is ever mutated into
 * something the JS side does not already know.
 *
 * WHY IT EXISTS: when the process is dead, JS does not run — but the user
 * still expects her 8am 早安 to arrive at 8am. The rows here carry text that
 * was **already final at schedule time** (the consistency rule in
 * specs/backfill.md), so posting one from Kotlin cannot contradict what the
 * app shows when it opens.
 *
 * WHAT IT DELIBERATELY DOES NOT CONTAIN: API keys, conversation history,
 * persona text, or anything a background LLM call would need. Kotlin never
 * generates content in this app (see WakeWorker's header for why that is a
 * feature, not a limitation), so the snapshot only carries what a notification
 * needs: who, when, what line (or none), and where a tap should land.
 *
 * Writes use commit(): the app may be killed seconds after going to
 * background, and an apply() still in flight would leave a stale snapshot to
 * be replayed for the next 24 hours.
 */
object Snapshot {
    private const val TAG = "AIWX-SNAP"
    private const val PREFS = "aiwx_native"
    private const val KEY_ITEMS = "wake_items"
    private const val KEY_FIRED = "wake_fired"
    private const val KEY_WRITTEN_AT = "wake_written_at"

    /** A snapshot older than this is not replayed: the world has moved on. */
    const val STALE_AFTER_MS = 48L * 3600_000

    /** Cap: one day of notifications for a chatty setup, no more. */
    private const val MAX_ITEMS = 64

    data class Item(
        val id: String,
        val fireAt: Long,
        val title: String,
        /** Empty = no-preview grade ("[你收到一条消息]"); never invent one here. */
        val body: String,
        val convId: String,
        val route: String,
        /** Avatar bytes as a data-less media ref is useless to Kotlin; a tint is enough. */
        val tint: String,
    )

    @Synchronized
    fun write(ctx: Context, itemsJson: String, now: Long) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = try {
            JSONArray(itemsJson)
        } catch (e: Exception) {
            Log.w(TAG, "malformed snapshot, keeping previous", e)
            return
        }
        val trimmed = if (arr.length() > MAX_ITEMS) {
            val out = JSONArray()
            for (i in 0 until MAX_ITEMS) out.put(arr.get(i))
            out
        } else arr
        prefs.edit()
            .putString(KEY_ITEMS, trimmed.toString())
            .putLong(KEY_WRITTEN_AT, now)
            .commit()
        // A rewrite means JS just re-derived the world: ids that are gone from
        // the new list can never fire, so their fired-marks are dead weight.
        pruneFired(ctx, trimmed)
        Log.i(TAG, "snapshot written items=" + trimmed.length())
    }

    @Synchronized
    fun items(ctx: Context): List<Item> {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_ITEMS, "[]") ?: "[]"
        val arr = try {
            JSONArray(raw)
        } catch (e: Exception) {
            return emptyList()
        }
        val out = ArrayList<Item>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id")
            if (id.isEmpty()) continue
            out.add(
                Item(
                    id = id,
                    fireAt = o.optLong("fireAt"),
                    title = o.optString("title"),
                    body = o.optString("body", ""),
                    convId = o.optString("convId"),
                    route = o.optString("route", DeepLink.chats()),
                    tint = o.optString("tint", "#7F7F7F"),
                ),
            )
        }
        return out
    }

    fun writtenAt(ctx: Context): Long =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_WRITTEN_AT, 0L)

    /**
     * Stale snapshots are not replayed. If the phone was off for three days,
     * firing yesterday's 早安 the moment it boots is worse than silence — the
     * app will backfill that window properly on next launch anyway.
     */
    fun isStale(ctx: Context, now: Long): Boolean {
        val at = writtenAt(ctx)
        return at <= 0L || now - at > STALE_AFTER_MS
    }

    /** Items due at [now] that have not been posted yet, oldest first. */
    @Synchronized
    fun due(ctx: Context, now: Long): List<Item> {
        if (isStale(ctx, now)) return emptyList()
        val fired = firedIds(ctx)
        return items(ctx)
            .filter { it.fireAt <= now && !fired.contains(it.id) }
            .sortedBy { it.fireAt }
    }

    /** The earliest future item — what the next exact alarm should target. */
    @Synchronized
    fun nextFireAt(ctx: Context, now: Long): Long? {
        if (isStale(ctx, now)) return null
        val fired = firedIds(ctx)
        return items(ctx)
            .filter { it.fireAt > now && !fired.contains(it.id) }
            .minOfOrNull { it.fireAt }
    }

    @Synchronized
    fun markFired(ctx: Context, ids: List<String>) {
        if (ids.isEmpty()) return
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val set = firedIds(ctx).toMutableSet()
        set.addAll(ids)
        prefs.edit().putStringSet(KEY_FIRED, set).commit()
    }

    @Synchronized
    fun firedIds(ctx: Context): Set<String> =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY_FIRED, emptySet()) ?: emptySet()

    private fun pruneFired(ctx: Context, live: JSONArray) {
        val liveIds = HashSet<String>()
        for (i in 0 until live.length()) {
            live.optJSONObject(i)?.optString("id")?.takeIf { it.isNotEmpty() }?.let { liveIds.add(it) }
        }
        val kept = firedIds(ctx).filterTo(HashSet()) { liveIds.contains(it) }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putStringSet(KEY_FIRED, kept).commit()
    }

    /** Test/diagnostic hook — also what 设置→原生增强 shows as "后台队列". */
    @Synchronized
    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_ITEMS).remove(KEY_FIRED).remove(KEY_WRITTEN_AT).commit()
    }
}
