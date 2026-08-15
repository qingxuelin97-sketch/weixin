package com.personal.weixinai.aiwx

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import com.personal.weixinai.R

/**
 * The app's own notification surface, complementing @capacitor/local-notifications:
 *
 * - the plugin owns PRE-SCHEDULED notifications (written before the app closed,
 *   fired by the OS while it is dead — lib/notify.ts);
 * - this object owns LIVE notifications for messages generated while the app is
 *   alive but backgrounded — which is the only place a RemoteInput reply action
 *   or a full-screen incoming call can be wired, because both need our own
 *   PendingIntents into ReplyReceiver / MainActivity.
 */
object Notifier {
    const val CHANNEL_MESSAGES = "aiwx_messages"
    const val CHANNEL_CALLS = "aiwx_calls"

    const val KEY_REPLY_TEXT = "aiwx_reply_text"
    const val EXTRA_CONV_ID = "aiwx_conv_id"
    const val EXTRA_NOTIF_ID = "aiwx_notif_id"

    const val ACTION_REPLY = "com.personal.weixinai.action.REPLY"
    const val ACTION_CALL_DECLINE = "com.personal.weixinai.action.CALL_DECLINE"

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, "消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "新消息（支持直接回复）"
            },
        )
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_CALLS, "来电", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "语音来电（全屏提醒）"
                // Ringing is the CallPage's job once it opens; a second, OS-level
                // loop over the notification sound reads as two phones ringing.
                setSound(null, null)
                enableVibration(true)
            },
        )
    }

    private fun canPost(ctx: Context): Boolean =
        NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    /**
     * A message notification with an inline-reply action. Tapping the body deep
     * links into the conversation; typing into the action lands in ReplyQueue.
     */
    fun notifyMessage(ctx: Context, convId: String, title: String, body: String, notifId: Int): Boolean {
        if (!canPost(ctx)) return false
        ensureChannels(ctx)

        val replyIntent = Intent(ctx, ReplyReceiver::class.java)
            .setAction(ACTION_REPLY)
            .putExtra(EXTRA_CONV_ID, convId)
            .putExtra(EXTRA_NOTIF_ID, notifId)
        // FLAG_MUTABLE is REQUIRED for RemoteInput: the system must be able to
        // append the typed text to this intent. Everything else stays immutable.
        val replyPi = PendingIntent.getBroadcast(
            ctx,
            DeepLink.requestCode("reply_$convId"),
            replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val remoteInput = RemoteInput.Builder(KEY_REPLY_TEXT).setLabel("回复").build()
        val replyAction = NotificationCompat.Action.Builder(R.drawable.ic_stat_aiwx, "回复", replyPi)
            .addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(false)
            .build()

        val n = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_aiwx)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(
                DeepLink.pendingIntent(ctx, DeepLink.chat(convId), DeepLink.requestCode("open_$convId")),
            )
            .addAction(replyAction)
            .build()
        NotificationManagerCompat.from(ctx).notify(notifId, n)
        return true
    }

    /**
     * Replace the reply-armed notification after a RemoteInput submit. Android
     * keeps the action's spinner turning until the SAME id is re-notified — a
     * silently dropped update looks like the reply hung forever.
     */
    fun notifyReplyQueued(ctx: Context, convId: String, title: String, notifId: Int) {
        if (!canPost(ctx)) return
        ensureChannels(ctx)
        val n = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_aiwx)
            .setContentTitle(title)
            // Honest wording: the text is QUEUED; it is actually sent by the
            // normal send path on the next foreground (specs/native-android.md).
            .setContentText("已收下，打开应用即发送")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setSilent(true)
            .setContentIntent(
                DeepLink.pendingIntent(ctx, DeepLink.chat(convId), DeepLink.requestCode("open_$convId")),
            )
            .build()
        NotificationManagerCompat.from(ctx).notify(notifId, n)
    }

    /**
     * Incoming-call notification with a full-screen intent: on a locked or idle
     * screen Android launches the deep link straight into CallPage's incoming
     * UI; otherwise it shows as a heads-up with 接听/拒绝.
     */
    fun notifyCall(ctx: Context, convId: String, name: String, notifId: Int): Boolean {
        if (!canPost(ctx)) return false
        ensureChannels(ctx)

        val fullScreen = DeepLink.pendingIntent(
            ctx, DeepLink.call(convId, accepted = false), DeepLink.requestCode("call_$convId"),
        )
        val accept = DeepLink.pendingIntent(
            ctx, DeepLink.call(convId, accepted = true), DeepLink.requestCode("call_accept_$convId"),
        )
        val declineIntent = Intent(ctx, ReplyReceiver::class.java)
            .setAction(ACTION_CALL_DECLINE)
            .putExtra(EXTRA_CONV_ID, convId)
            .putExtra(EXTRA_NOTIF_ID, notifId)
        val decline = PendingIntent.getBroadcast(
            ctx,
            DeepLink.requestCode("call_decline_$convId"),
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val n = NotificationCompat.Builder(ctx, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_aiwx)
            .setContentTitle(name)
            .setContentText("邀请你语音通话…")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .addAction(R.drawable.ic_stat_aiwx, "拒绝", decline)
            .addAction(R.drawable.ic_stat_aiwx, "接听", accept)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        // A call that never gets answered must not ring the shade forever —
        // the JS side cancels on timeout, but flag insistent behaviour off.
        n.flags = n.flags and Notification.FLAG_INSISTENT.inv()
        NotificationManagerCompat.from(ctx).notify(notifId, n)
        return true
    }

    fun cancel(ctx: Context, notifId: Int) {
        NotificationManagerCompat.from(ctx).cancel(notifId)
    }
}
