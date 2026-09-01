package com.personal.weixinai.aiwx

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * 周期唤醒 (M-J4). The coarse half of the wake pair (see Wake.kt's header for
 * the exact-alarm half and for why Kotlin never generates content).
 *
 * WorkManager is used precisely because it is boring: it survives process
 * death, app upgrade and reboot without a receiver of its own, and OEM battery
 * managers delay it rather than dropping it silently forever. 15 minutes is the
 * platform floor for periodic work — asking for less does not get less, it just
 * gets rounded up, so the exact alarm carries punctuality and this carries
 * reliability.
 *
 * The work itself is deliberately trivial: read the snapshot, post what is due,
 * refresh the widget. No network, no LLM, no writes to conversation state — a
 * worker that can only ever post a line JS already wrote cannot corrupt
 * anything if it runs at a strange time.
 */
class WakeWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        return try {
            val now = System.currentTimeMillis()
            val posted = Wake.deliverDue(applicationContext, now)
            // The home-screen widget shows unread + latest preview; a wake that
            // posted something has by definition made it stale.
            if (posted > 0) {
                try {
                    AiwxWidgetProvider.pushUpdate(applicationContext)
                } catch (e: Exception) {
                    Log.w(TAG, "widget refresh failed", e)
                }
            }
            Result.success()
        } catch (e: Exception) {
            // retry(), not failure(): a transient SharedPreferences/notification
            // hiccup should not stop the periodic chain for the rest of the day.
            Log.w(TAG, "wake work failed", e)
            Result.retry()
        }
    }

    companion object {
        private const val TAG = "AIWX-WAKE"
        const val WORK_NAME = "aiwx_wake"

        /**
         * Idempotent: KEEP means calling this on every launch (MainActivity)
         * costs nothing and self-heals a chain that a "force stop" cancelled.
         */
        fun ensureScheduled(ctx: Context) {
            try {
                val req = PeriodicWorkRequestBuilder<WakeWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(
                        // No network constraint on purpose: delivery is local.
                        Constraints.Builder().setRequiresBatteryNotLow(false).build(),
                    )
                    .build()
                WorkManager.getInstance(ctx)
                    .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
                Log.i(TAG, "periodic wake ensured")
            } catch (e: Exception) {
                // WorkManager initialisation can fail on badly-modified ROMs.
                // The app must still start; the exact alarm remains as cover.
                Log.w(TAG, "could not schedule periodic wake", e)
            }
        }

        fun cancel(ctx: Context) {
            try {
                WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME)
            } catch (e: Exception) {
                Log.w(TAG, "cancel failed", e)
            }
        }
    }
}
