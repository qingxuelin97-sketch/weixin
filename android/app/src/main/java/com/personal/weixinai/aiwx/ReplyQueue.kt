package com.personal.weixinai.aiwx

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The bridge queue between the notification shade and the WebView.
 *
 * A RemoteInput reply arrives in a BroadcastReceiver with NO WebView running
 * (or a frozen one) — it cannot be "sent" right there. So it is appended here,
 * to a SharedPreferences-backed JSON queue, and the next foreground pass
 * (src/app/useSchedulerRuntime.ts → src/native/reply-drain.ts) drains it
 * through the NORMAL send path. The reply is therefore never a second way to
 * mutate the conversation — it is the same sendUserMessage() every typed
 * message takes, merely time-shifted.
 *
 * Writes use commit() (synchronous), not apply(): the receiver's process may be
 * killed the moment onReceive returns, and an apply() still sitting in its
 * background writer would silently lose the user's words.
 */
object ReplyQueue {
    private const val TAG = "AIWX-REPLYQ"
    private const val PREFS = "aiwx_native"
    private const val KEY = "reply_queue"

    /** Hard cap: a queue nobody drains must not grow without bound. */
    private const val MAX_ITEMS = 50

    const val KIND_REPLY = "reply"
    const val KIND_CALL_DECLINED = "call_declined"

    @Synchronized
    fun enqueue(ctx: Context, kind: String, convId: String, text: String?, at: Long) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = try {
            JSONArray(prefs.getString(KEY, "[]"))
        } catch (e: Exception) {
            JSONArray() // a corrupt queue must not brick replies forever
        }
        if (arr.length() >= MAX_ITEMS) {
            Log.w(TAG, "queue full, dropping oldest")
            arr.remove(0)
        }
        val item = JSONObject()
        item.put("kind", kind)
        item.put("convId", convId)
        if (text != null) item.put("text", text)
        item.put("at", at)
        arr.put(item)
        prefs.edit().putString(KEY, arr.toString()).commit()
        Log.i(TAG, "enqueued kind=$kind conv=$convId size=" + arr.length())
    }

    /** Atomically read-and-clear. Returns the raw JSON array string. */
    @Synchronized
    fun drain(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY, "[]") ?: "[]"
        prefs.edit().putString(KEY, "[]").commit()
        return raw
    }

    @Synchronized
    fun size(ctx: Context): Int = try {
        JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]")).length()
    } catch (e: Exception) {
        0
    }
}
