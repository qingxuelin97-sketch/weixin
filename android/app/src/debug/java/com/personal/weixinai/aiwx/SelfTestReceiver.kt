package com.personal.weixinai.aiwx

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * DEBUG-BUILD-ONLY test terminal for the CI emulator (device-test.yml, I10 job).
 *
 * adb cannot drive the system's RemoteInput UI or place a widget on a launcher,
 * so the emulator loop exercises each native surface one step inside the system
 * boundary instead:
 *
 *   am broadcast -n com.personal.weixinai/.aiwx.SelfTestReceiver -a <ACTION>
 *
 *   …selftest.NOTIFY  → posts the real RemoteInput message notification
 *   …selftest.REPLY   → enqueues a synthetic reply exactly as ReplyReceiver
 *                        would (same ReplyQueue path); JS drains it on the next
 *                        foreground and logs AIWX-REPLYQ, which CI asserts
 *   …selftest.CALL    → posts the real full-screen call notification
 *   …selftest.BUBBLE  → shows the real overlay bubble (CI grants the appop first)
 *   …selftest.WIDGET  → writes sample widget data and forces a provider render
 *
 * Lives in src/debug/ so release APKs contain neither the class nor the
 * exported receiver (see src/debug/AndroidManifest.xml).
 */
class SelfTestReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val convId = intent.getStringExtra("convId") ?: "ci-selftest"
        when (intent.action) {
            "com.personal.weixinai.selftest.NOTIFY" -> {
                val ok = Notifier.notifyMessage(
                    ctx, convId, "CI 自检", "这是一条带 RemoteInput 的测试通知",
                    DeepLink.requestCode("selftest_msg"),
                )
                Log.i(TAG, "notify posted=$ok")
            }
            "com.personal.weixinai.selftest.REPLY" -> {
                val text = intent.getStringExtra("text") ?: "ci-hello"
                ReplyQueue.enqueue(ctx, ReplyQueue.KIND_REPLY, convId, text, System.currentTimeMillis())
                Log.i(TAG, "reply enqueued size=" + ReplyQueue.size(ctx))
            }
            "com.personal.weixinai.selftest.CALL" -> {
                val ok = Notifier.notifyCall(ctx, convId, "CI 来电", DeepLink.requestCode("selftest_call"))
                Log.i(TAG, "call posted=$ok")
            }
            "com.personal.weixinai.selftest.BUBBLE" -> {
                ctx.startService(
                    Intent(ctx, BubbleService::class.java)
                        .setAction(BubbleService.ACTION_SHOW)
                        .putExtra(BubbleService.EXTRA_CONV_ID, convId)
                        .putExtra(BubbleService.EXTRA_TITLE, "CI 自检")
                        .putExtra(BubbleService.EXTRA_TEXT, "悬浮气泡测试"),
                )
                Log.i(TAG, "bubble requested")
            }
            "com.personal.weixinai.selftest.WIDGET" -> {
                WidgetStore.write(ctx, 3, "CI 自检", "小组件测试预览", convId, System.currentTimeMillis())
                AiwxWidgetProvider.pushUpdate(ctx)
                Log.i(TAG, "widget updated")
            }
            else -> Log.w(TAG, "unknown action " + intent.action)
        }
    }

    companion object {
        private const val TAG = "AIWX-SELFTEST-NATIVE"
    }
}
