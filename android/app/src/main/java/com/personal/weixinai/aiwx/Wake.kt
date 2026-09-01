package com.personal.weixinai.aiwx

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * 她在后台活着 (M-J4)：把已经写好的到期项投递出去，然后给下一项上闹钟。
 *
 * ## 为什么 Kotlin 不生成内容
 *
 * The original plan had Kotlin call the chat endpoint itself when a heartbeat
 * came due with the app dead. It cannot, and should not:
 *
 *  - the API key is sealed under a **non-extractable** WebCrypto CryptoKey in
 *    IndexedDB (src/lib/keystore.ts). Kotlin reading it is not "hard", it is
 *    cryptographically impossible — and making it possible would mean marking
 *    the master key extractable, gutting 铁律 2 for everyone;
 *  - generating in Kotlin would put a SECOND content producer outside the JS
 *    engine, which is the thing 铁律 5 exists to prevent — and it would need
 *    its own copy of the tier routing (铁律 6) to avoid posting explicit text
 *    to a mainland endpoint from a code path no nsfw-callsite test can see.
 *
 * So the split is: **JS decides what will be said and when; Kotlin only
 * delivers it.** Every row in the snapshot was final at schedule time (the
 * consistency rule in specs/backfill.md), so a notification posted from here
 * can never contradict what the app shows once opened. The offline world
 * evolution the user actually sees is still `simulate()` + backfill, exactly
 * as before — this layer makes sure the *knock on the door* arrives on time.
 *
 * ## Two wake sources, one delivery path
 *
 *  - **WorkManager** (WakeWorker, ~every 15 min): the reliable-but-coarse one.
 *    Survives process death and reboot on its own; OEM battery managers may
 *    delay it, never silently drop it forever.
 *  - **AlarmManager exact alarm**: the punctual one, armed at the single next
 *    due item. `setExactAndAllowWhileIdle` pierces Doze. On Android 12+ this
 *    needs SCHEDULE_EXACT_ALARM (declared M-J4b) and the user can revoke it —
 *    `canScheduleExactAlarms()` is checked every time and we fall back to an
 *    inexact `set()` rather than crashing (an un-caught SecurityException here
 *    would take down a BroadcastReceiver in the background: invisible, fatal).
 *
 * Both funnel into [deliverDue], which is idempotent through Snapshot's fired
 * set — a worker run and an alarm firing in the same second post once.
 */
object Wake {
    private const val TAG = "AIWX-WAKE"
    const val ACTION_WAKE = "com.personal.weixinai.aiwx.WAKE"

    /**
     * Post everything due, mark it, and re-arm for the next one.
     * @return how many notifications were actually posted.
     */
    fun deliverDue(ctx: Context, now: Long): Int {
        val due = Snapshot.due(ctx, now)
        if (due.isEmpty()) {
            rearm(ctx, now)
            return 0
        }
        var posted = 0
        val fired = ArrayList<String>(due.size)
        for (item in due) {
            // Grading is JS-side and already baked in: an empty body IS the
            // no-preview grade. Kotlin must never invent a line to fill it —
            // that is exactly how a "followup" would start lying.
            val ok = Notifier.notifyConversation(
                ctx,
                convId = item.convId,
                title = item.title,
                body = item.body.ifEmpty { "[你收到一条消息]" },
                notifId = DeepLink.requestCode("wake_" + item.id),
                route = item.route,
                tint = item.tint,
            )
            fired.add(item.id) // marked even if posting was refused: a denied
            // POST_NOTIFICATIONS must not make this row retry every 15 minutes
            // for a day.
            if (ok) posted++
        }
        Snapshot.markFired(ctx, fired)
        Log.i(TAG, "delivered $posted/${due.size}")
        rearm(ctx, now)
        return posted
    }

    /** Arm an exact alarm at the next pending item (no-op when there is none). */
    fun rearm(ctx: Context, now: Long) {
        val next = Snapshot.nextFireAt(ctx, now) ?: return
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pi = PendingIntent.getBroadcast(
            ctx,
            REQ_ALARM,
            Intent(ctx, WakeAlarmReceiver::class.java).setAction(ACTION_WAKE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        try {
            val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
            if (exact) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
            } else {
                // The user turned exact alarms off in system settings. Honest
                // degradation: still wake, just not to the minute.
                am.set(AlarmManager.RTC_WAKEUP, next, pi)
            }
            Log.i(TAG, "armed exact=$exact at $next")
        } catch (e: SecurityException) {
            Log.w(TAG, "exact alarm denied, falling back", e)
            try {
                am.set(AlarmManager.RTC_WAKEUP, next, pi)
            } catch (e2: Exception) {
                Log.w(TAG, "alarm set failed entirely", e2)
            }
        }
    }

    private const val REQ_ALARM = 0x41_57_01
}

/** The exact alarm landed: deliver and re-arm. */
class WakeAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // goAsync() is deliberately NOT used: everything here is SharedPreferences
        // + NotificationManager, both synchronous and fast. An async receiver
        // that outlives onReceive is the classic way to get killed mid-write.
        try {
            Wake.deliverDue(context.applicationContext, System.currentTimeMillis())
        } catch (e: Exception) {
            Log.w("AIWX-WAKE", "alarm delivery failed", e)
        }
    }
}

/**
 * Alarms do not survive a reboot; the snapshot does. Re-arm on boot so the
 * first message after the user restarts their phone is not silently skipped.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val a = intent.action ?: return
        if (a != Intent.ACTION_BOOT_COMPLETED && a != Intent.ACTION_MY_PACKAGE_REPLACED) return
        try {
            val ctx = context.applicationContext
            val now = System.currentTimeMillis()
            // Anything that came due while the phone was off is delivered now —
            // unless the snapshot is stale, in which case Snapshot.due() is
            // empty by design and the app will backfill properly on launch.
            Wake.deliverDue(ctx, now)
            WakeWorker.ensureScheduled(ctx)
        } catch (e: Exception) {
            Log.w("AIWX-WAKE", "boot re-arm failed", e)
        }
    }
}
