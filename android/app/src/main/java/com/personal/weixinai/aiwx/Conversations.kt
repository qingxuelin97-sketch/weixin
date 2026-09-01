package com.personal.weixinai.aiwx

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.Log
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * 对话式通知的记忆与门面 (M-J4).
 *
 * MessagingStyle needs two things a plain notification does not: a *Person*
 * (name + avatar, which is what puts the notification in Android 11+'s
 * 「对话」section and lets the user pin or bubble it) and a *history* — the
 * two or three lines before this one, stacked in the shade the way a real chat
 * app does it. Neither exists in a notification payload, so both live here.
 *
 * The history is capped and per-conversation; it holds only lines that were
 * ALREADY displayed as notifications, so nothing here can leak content the
 * user has not already been shown. It is cleared when the conversation is
 * opened (JS side calls clear through the bridge on foreground).
 *
 * Avatars: the real avatar is a Blob in IndexedDB, unreachable from a
 * background Kotlin process. Rather than ship no icon (which reads as "some
 * app" rather than "她"), we draw the same tinted initial the JS Avatar
 * component falls back to — the two look like the same person because they
 * ARE the same rule, and the tint travels in the snapshot row.
 */
object Conversations {
    private const val TAG = "AIWX-CONV"
    private const val PREFS = "aiwx_native"
    private const val KEY = "conv_history"

    /** WeChat shows a handful of stacked lines; more is noise in a shade. */
    private const val MAX_LINES = 5

    data class Line(val text: String, val at: Long)

    @Synchronized
    fun append(ctx: Context, convId: String, text: String, at: Long) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val root = try {
            JSONObject(prefs.getString(KEY, "{}") ?: "{}")
        } catch (e: Exception) {
            JSONObject()
        }
        val arr = root.optJSONArray(convId) ?: JSONArray()
        val item = JSONObject().put("t", text).put("at", at)
        arr.put(item)
        val trimmed = if (arr.length() > MAX_LINES) {
            val out = JSONArray()
            for (i in (arr.length() - MAX_LINES) until arr.length()) out.put(arr.get(i))
            out
        } else arr
        root.put(convId, trimmed)
        prefs.edit().putString(KEY, root.toString()).commit()
    }

    @Synchronized
    fun lines(ctx: Context, convId: String): List<Line> {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val root = try {
            JSONObject(prefs.getString(KEY, "{}") ?: "{}")
        } catch (e: Exception) {
            return emptyList()
        }
        val arr = root.optJSONArray(convId) ?: return emptyList()
        val out = ArrayList<Line>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val t = o.optString("t")
            if (t.isNotEmpty()) out.add(Line(t, o.optLong("at")))
        }
        return out
    }

    /** Called when the user actually opens that chat — the shade is caught up. */
    @Synchronized
    fun clear(ctx: Context, convId: String) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val root = try {
            JSONObject(prefs.getString(KEY, "{}") ?: "{}")
        } catch (e: Exception) {
            return
        }
        root.remove(convId)
        prefs.edit().putString(KEY, root.toString()).commit()
    }

    @Synchronized
    fun clearAll(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).commit()
    }

    /**
     * The tinted-initial avatar, drawn to match src/components/Avatar.tsx's
     * placeholder: a rounded square, brand-ish tint, one big glyph.
     */
    fun avatarIcon(name: String, tintHex: String): IconCompat? = try {
        val size = 128
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val tint = try {
            Color.parseColor(if (tintHex.startsWith("#")) tintHex else "#$tintHex")
        } catch (e: IllegalArgumentException) {
            Color.parseColor("#7F7F7F")
        }
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = tint }
        // A circle, not the app's rounded square: the system re-clips
        // conversation icons to a circle anyway, and a square drawn inside that
        // clip loses its corners and looks like a rendering bug.
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, bg)
        val glyph = name.trim().take(1).ifEmpty { "·" }
        val fg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = size * 0.5f
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        }
        val baseline = size / 2f - (fg.descent() + fg.ascent()) / 2f
        canvas.drawText(glyph, size / 2f, baseline, fg)
        IconCompat.createWithBitmap(bmp)
    } catch (e: Exception) {
        Log.w(TAG, "avatar draw failed", e)
        null
    }
}
