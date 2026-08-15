package com.personal.weixinai.aiwx

import android.content.Context

/**
 * The widget's data cache: written by the JS bridge (updateWidget) whenever the
 * app has fresh state, read by AiwxWidgetProvider whenever the launcher asks
 * for a render. SharedPreferences because the provider runs with no WebView.
 *
 * The JS producer (src/native/widget-sync.ts) filters hidden AI↔AI DM threads
 * BEFORE the data crosses the bridge — this layer never sees them, so a future
 * refactor of the provider cannot leak one.
 */
object WidgetStore {
    private const val PREFS = "aiwx_widget"

    data class Snapshot(
        val unread: Int,
        val title: String,
        val preview: String,
        val convId: String,
        val updatedAt: Long,
    )

    fun write(ctx: Context, unread: Int, title: String, preview: String, convId: String, at: Long) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt("unread", unread)
            .putString("title", title)
            .putString("preview", preview)
            .putString("convId", convId)
            .putLong("updatedAt", at)
            .apply()
    }

    fun read(ctx: Context): Snapshot {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Snapshot(
            unread = p.getInt("unread", 0),
            title = p.getString("title", "微信") ?: "微信",
            preview = p.getString("preview", "暂无消息") ?: "暂无消息",
            convId = p.getString("convId", "") ?: "",
            updatedAt = p.getLong("updatedAt", 0L),
        )
    }
}
