package com.personal.weixinai.aiwx

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput

/**
 * Terminal for the two notification actions that carry intent BACK from the
 * shade: an inline reply and a call decline. Both are recorded into ReplyQueue
 * (never acted on here — a BroadcastReceiver has ~10s and no WebView) and
 * materialized by the next foreground pass through the normal engine paths.
 */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val convId = intent.getStringExtra(Notifier.EXTRA_CONV_ID) ?: return
        val notifId = intent.getIntExtra(Notifier.EXTRA_NOTIF_ID, 0)
        when (intent.action) {
            Notifier.ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(Notifier.KEY_REPLY_TEXT)
                    ?.toString()
                    ?.trim()
                if (text.isNullOrEmpty()) {
                    // The spinner must still be released even for an empty submit.
                    Notifier.cancel(ctx, notifId)
                    return
                }
                ReplyQueue.enqueue(ctx, ReplyQueue.KIND_REPLY, convId, text, System.currentTimeMillis())
                // Mandatory: re-notify the SAME id or the RemoteInput UI spins forever.
                Notifier.notifyReplyQueued(ctx, convId, "已收下回复", notifId)
            }
            Notifier.ACTION_CALL_DECLINE -> {
                ReplyQueue.enqueue(ctx, ReplyQueue.KIND_CALL_DECLINED, convId, null, System.currentTimeMillis())
                Notifier.cancel(ctx, notifId)
            }
            else -> Log.w("AIWX-REPLYQ", "unknown action " + intent.action)
        }
    }
}
