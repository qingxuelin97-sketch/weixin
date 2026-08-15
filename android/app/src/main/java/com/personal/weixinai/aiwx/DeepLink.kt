package com.personal.weixinai.aiwx

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.personal.weixinai.MainActivity

/**
 * The single way any native surface re-enters the app: an ACTION_VIEW intent
 * with an aiwx:// URI, aimed explicitly at MainActivity (launchMode singleTask,
 * so a running instance gets onNewIntent instead of a second copy). Capacitor
 * turns it into the JS `appUrlOpen` event; src/native/deep-link.ts allowlists
 * the route before navigating.
 */
object DeepLink {
    /** aiwx://chat/<convId> — convId is URL-encoded because ids are free-form. */
    fun chat(convId: String): String = "aiwx://chat/" + Uri.encode(convId)

    fun call(convId: String, accepted: Boolean): String =
        "aiwx://call/" + Uri.encode(convId) + "?incoming=1" + (if (accepted) "&accept=1" else "")

    fun chats(): String = "aiwx://chats"

    /**
     * Activity PendingIntent for a deep link. requestCode must differ per
     * target URI: PendingIntents with the same requestCode+Intent-filterEquals
     * collapse into one, and two notifications would then open the same chat.
     */
    fun pendingIntent(ctx: Context, uri: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
            .setClass(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            ctx,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Launch a deep link directly (bubble tap — no notification involved). */
    fun launch(ctx: Context, uri: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
            .setClass(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        ctx.startActivity(intent)
    }

    /** Stable per-string requestCode (same derivation idea as lib/notify.ts). */
    fun requestCode(key: String): Int {
        var h = 0
        for (c in key) h = (h * 31 + c.code) or 0
        return Math.abs(h) % 2_000_000_000
    }
}
