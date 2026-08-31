package com.personal.weixinai.aiwx

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import com.personal.weixinai.R

/**
 * Home-screen widget: unread badge + latest conversation preview. Data flows
 * one way — JS writes WidgetStore via the bridge, then pushUpdate() renders.
 * updatePeriodMillis is 0 in aiwx_widget_info.xml: the launcher never polls,
 * the app pushes (on foreground pass and on backgrounding), so the widget is
 * exactly as fresh as the app's own knowledge, never fresher, never staler.
 */
class AiwxWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        render(ctx, mgr, ids)
    }

    companion object {
        private const val TAG = "AIWX-WIDGET"

        fun pushUpdate(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, AiwxWidgetProvider::class.java))
            render(ctx, mgr, ids)
        }

        private fun render(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
            val snap = WidgetStore.read(ctx)
            // One log line either way: CI asserts the provider actually ran even
            // when the emulator has no widget placed on a launcher (ids empty).
            Log.i(TAG, "render unread=" + snap.unread + " ids=" + ids.size)
            for (id in ids) {
                val views = RemoteViews(ctx.packageName, R.layout.aiwx_widget)
                views.setTextViewText(R.id.aiwx_widget_title, snap.title)
                views.setTextViewText(R.id.aiwx_widget_preview, snap.preview)
                if (snap.unread > 0) {
                    views.setViewVisibility(R.id.aiwx_widget_badge, View.VISIBLE)
                    views.setTextViewText(
                        R.id.aiwx_widget_badge,
                        if (snap.unread > 99) "99+" else snap.unread.toString(),
                    )
                } else {
                    views.setViewVisibility(R.id.aiwx_widget_badge, View.GONE)
                }
                val uri = if (snap.convId.isNotEmpty()) DeepLink.chat(snap.convId) else DeepLink.chats()
                views.setOnClickPendingIntent(
                    R.id.aiwx_widget_root,
                    DeepLink.pendingIntent(ctx, uri, DeepLink.requestCode("widget_$id")),
                )
                mgr.updateAppWidget(id, views)
            }
        }
    }
}
