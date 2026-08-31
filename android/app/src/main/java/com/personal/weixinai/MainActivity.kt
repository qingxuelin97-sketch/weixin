package com.personal.weixinai

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.personal.weixinai.aiwx.AiwxNativePlugin
import com.personal.weixinai.aiwx.Notifier

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
    }
}
