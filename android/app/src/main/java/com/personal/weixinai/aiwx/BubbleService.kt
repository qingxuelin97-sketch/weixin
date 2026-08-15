package com.personal.weixinai.aiwx

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.personal.weixinai.R
import kotlin.math.abs

/**
 * WeChat-style floating message chip drawn over other apps (SYSTEM_ALERT_WINDOW).
 *
 * Deliberately a plain Service, not a foreground one: its producer is the live
 * WebView (src/native/background-notify.ts fires it as the app is backgrounded),
 * so the bubble's useful lifetime is exactly the process's. It auto-hides after
 * AUTO_HIDE_MS, hides on tap (after deep-linking into the chat), and can be
 * dragged vertically along the screen edge.
 */
class BubbleService : Service() {
    companion object {
        const val ACTION_SHOW = "com.personal.weixinai.bubble.SHOW"
        const val ACTION_HIDE = "com.personal.weixinai.bubble.HIDE"
        const val EXTRA_CONV_ID = "convId"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val AUTO_HIDE_MS = 12_000L
        private const val TAG = "AIWX-BUBBLE"
    }

    private var bubble: View? = null
    private var convId: String = ""
    private val handler = Handler(Looper.getMainLooper())
    private val autoHide = Runnable { hide() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SHOW -> show(
                intent.getStringExtra(EXTRA_CONV_ID) ?: "",
                intent.getStringExtra(EXTRA_TITLE) ?: "",
                intent.getStringExtra(EXTRA_TEXT) ?: "",
            )
            ACTION_HIDE -> hide()
        }
        return START_NOT_STICKY
    }

    private fun windowType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

    @SuppressLint("InflateParams", "ClickableViewAccessibility")
    private fun show(conv: String, title: String, text: String) {
        if (!Settings.canDrawOverlays(this)) {
            // The JS side checks first, but the permission can be revoked from
            // system settings at any time — never crash, just decline.
            Log.w(TAG, "overlay permission missing, not showing")
            stopSelf()
            return
        }
        convId = conv
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager

        if (bubble == null) {
            val view = LayoutInflater.from(this).inflate(R.layout.aiwx_bubble, null)
            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                windowType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT,
            )
            params.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            params.y = dp(24)

            var downRawY = 0f
            var downParamY = 0
            var moved = false
            view.setOnTouchListener { v, ev ->
                when (ev.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        downRawY = ev.rawY
                        downParamY = params.y
                        moved = false
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dy = ev.rawY - downRawY
                        if (abs(dy) > dp(6)) moved = true
                        // Slightly past the top edge is allowed — that overshoot
                        // is what the flick-up-to-dismiss below reads.
                        params.y = (downParamY + dy.toInt()).coerceAtLeast(-dp(40))
                        try {
                            wm.updateViewLayout(v, params)
                        } catch (e: Exception) {
                            /* view already removed mid-gesture */
                        }
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (!moved) {
                            // A tap: open the conversation, then get out of the way.
                            DeepLink.launch(this, DeepLink.chat(convId))
                            hide()
                        } else if (params.y < -dp(2)) {
                            hide() // flicked off the top edge = dismiss
                        }
                        true
                    }
                    else -> false
                }
            }
            try {
                wm.addView(view, params)
            } catch (e: Exception) {
                Log.e(TAG, "addView failed: " + e.message)
                stopSelf()
                return
            }
            bubble = view
        }

        bubble?.findViewById<TextView>(R.id.aiwx_bubble_title)?.text = title
        bubble?.findViewById<TextView>(R.id.aiwx_bubble_text)?.text = text
        handler.removeCallbacks(autoHide)
        handler.postDelayed(autoHide, AUTO_HIDE_MS)
        Log.i(TAG, "shown conv=$convId")
    }

    private fun hide() {
        handler.removeCallbacks(autoHide)
        bubble?.let {
            try {
                (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(it)
            } catch (e: Exception) {
                /* already gone */
            }
        }
        bubble = null
        stopSelf()
    }

    override fun onDestroy() {
        // The system killing the service must not strand an orphan window.
        handler.removeCallbacks(autoHide)
        bubble?.let {
            try {
                (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(it)
            } catch (e: Exception) {
                /* already gone */
            }
        }
        bubble = null
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
