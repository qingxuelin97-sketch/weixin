package com.personal.weixinai

import android.content.Intent
import android.os.Build
import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.personal.weixinai.aiwx.AiwxNativePlugin
import com.personal.weixinai.aiwx.Notifier
import com.personal.weixinai.aiwx.WakeWorker

/**
 * Replaces the template MainActivity.java (M-I10). Plugin registration must
 * happen BEFORE super.onCreate(), where the Capacitor bridge is assembled.
 *
 * Deep links (aiwx:// VIEW intents from the bubble, notifications and the
 * widget) need no code here: BridgeActivity already forwards both the launch
 * intent and onNewIntent() to the App plugin, which surfaces them to JS as
 * `appUrlOpen` (consumed by src/app/useDeepLinks.ts).
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AiwxNativePlugin::class.java)
        applyLockscreenForIntent(intent)
        super.onCreate(savedInstanceState)
        // Channels are created HERE, at launch, and not lazily inside
        // notifyMessage/notifyCall (M-I18). Those two return early when
        // POST_NOTIFICATIONS is denied — which is the DEFAULT on Android 13+ —
        // so the channels sat behind the very permission gate that needed them
        // to exist: 「设置 → 应用 → 通知」 listed only Capacitor's `default`
        // channel, and the user had no 消息 / 来电 categories to turn on. The
        // emulator dump proved it: zero `aiwx_` channels on a booted install.
        // Creating a channel needs no permission, so this is safe to do
        // unconditionally and idempotent on every later launch.
        Notifier.ensureChannels(this)
        // M-J4: idempotent (KEEP policy), so every launch self-heals a periodic
        // chain that a "force stop" or an OEM cleaner cancelled while we slept.
        WakeWorker.ensureScheduled(this)
    }

    override fun onNewIntent(intent: Intent) {
        applyLockscreenForIntent(intent)
        super.onNewIntent(intent)
    }

    /**
     * 锁屏来电 (M-J4b): the full-screen call notification (M-I10) fires a
     * `aiwx://call/...?incoming=1` intent, but on a locked phone an activity
     * only appears over the keyguard with showWhenLocked — without it the
     * fullScreenIntent's behavior is whatever the OEM feels like (usually a
     * heads-up you cannot answer from).
     *
     * The flags are set DYNAMICALLY per intent, never in the manifest: static
     * showWhenLocked would put the ENTIRE app above the keyguard — every
     * message-notification tap would open your chats on a locked phone, which
     * is a privacy hole, not a feature. Non-call intents explicitly RESET the
     * flags because the activity instance (singleTask) survives between
     * intents — a stale `true` from an old call would leak the whole app past
     * the lock screen forever after.
     */
    private fun applyLockscreenForIntent(intent: Intent?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return
        val u = intent?.data
        val isIncomingCall =
            u?.scheme == "aiwx" && u.host == "call" && u.getQueryParameter("incoming") == "1"
        setShowWhenLocked(isIncomingCall)
        setTurnScreenOn(isIncomingCall)
    }
}
