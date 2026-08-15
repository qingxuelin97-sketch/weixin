package com.personal.weixinai

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.personal.weixinai.aiwx.AiwxNativePlugin

/**
 * Replaces the template MainActivity.java (M-I10). The only change is the
 * plugin registration — custom plugins must be registered BEFORE
 * super.onCreate(), where the Capacitor bridge is assembled.
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
    }
}
