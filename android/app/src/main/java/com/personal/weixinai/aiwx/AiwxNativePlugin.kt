package com.personal.weixinai.aiwx

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray

/**
 * The one custom plugin (M-I10). Registered in MainActivity; consumed ONLY via
 * the plain-function wrappers in src/native/bridge.ts — never resolve a promise
 * with the plugin proxy itself (the thenable trap that killed three weeks of
 * device builds; see tests/unit/plugin-proxy.test.ts).
 *
 * Every method resolves (possibly with ok:false) instead of throwing for
 * expected conditions; reject() is reserved for programmer errors (missing
 * required args), so JS `catch` blocks stay meaningful.
 */
@CapacitorPlugin(name = "AiwxNative")
class AiwxNativePlugin : Plugin() {

    // ----------------------------------------------------------- SSE (M-J5)

    // All OkHttp mechanics live in SseBridge — this class stays a thin
    // @PluginMethod façade. The lambda is the ONLY place events enter the
    // WebView, so the event name is written exactly once on the Kotlin side.
    private val sse by lazy { SseBridge { ev -> notifyListeners("sseLine", ev) } }

    @PluginMethod
    fun sseStart(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val url = call.getString("url") ?: return call.reject("url required")
        sse.start(
            id,
            url,
            call.getString("headersJson") ?: "{}",
            call.getString("bodyJson") ?: "{}",
        )
        // Resolve on DISPATCH, not on response: the response arrives as events.
        call.resolve()
    }

    @PluginMethod
    fun sseCancel(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        sse.cancel(id)
        call.resolve()
    }

    override fun handleOnDestroy() {
        // The WebView is going away; a socket nobody can read must not linger.
        sse.destroy()
        super.handleOnDestroy()
    }

    // ---------------------------------------------------------------- info

    @PluginMethod
    fun deviceInfo(call: PluginCall) {
        val ret = JSObject()
        ret.put("manufacturer", Build.MANUFACTURER ?: "")
        ret.put("brand", Build.BRAND ?: "")
        ret.put("sdkInt", Build.VERSION.SDK_INT)
        call.resolve(ret)
    }

    // ------------------------------------------------------------- overlay

    @PluginMethod
    fun overlayGranted(call: PluginCall) {
        val ret = JSObject()
        ret.put("granted", Settings.canDrawOverlays(context))
        call.resolve(ret)
    }

    @PluginMethod
    fun requestOverlay(call: PluginCall) {
        // Fire the system page and resolve immediately — the grant is read back
        // by polling overlayGranted() on the next foreground, which also covers
        // the user granting/revoking it out-of-band in system settings.
        val ret = JSObject()
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + context.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            ret.put("launched", true)
        } catch (e: ActivityNotFoundException) {
            ret.put("launched", false)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun showBubble(call: PluginCall) {
        val convId = call.getString("convId") ?: return call.reject("convId required")
        if (!Settings.canDrawOverlays(context)) {
            val ret = JSObject()
            ret.put("shown", false)
            ret.put("reason", "overlay_denied")
            return call.resolve(ret)
        }
        val intent = Intent(context, BubbleService::class.java)
            .setAction(BubbleService.ACTION_SHOW)
            .putExtra(BubbleService.EXTRA_CONV_ID, convId)
            .putExtra(BubbleService.EXTRA_TITLE, call.getString("title") ?: "")
            .putExtra(BubbleService.EXTRA_TEXT, call.getString("text") ?: "")
        context.startService(intent)
        val ret = JSObject()
        ret.put("shown", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun hideBubble(call: PluginCall) {
        context.startService(
            Intent(context, BubbleService::class.java).setAction(BubbleService.ACTION_HIDE),
        )
        call.resolve()
    }

    // --------------------------------------------------------- notifications

    @PluginMethod
    fun notifyMessage(call: PluginCall) {
        val convId = call.getString("convId") ?: return call.reject("convId required")
        val posted = Notifier.notifyMessage(
            context,
            convId,
            call.getString("title") ?: "微信",
            call.getString("body") ?: "[你收到一条消息]",
            call.getInt("id") ?: DeepLink.requestCode("msg_$convId"),
        )
        val ret = JSObject()
        ret.put("posted", posted)
        call.resolve(ret)
    }

    @PluginMethod
    fun notifyCall(call: PluginCall) {
        val convId = call.getString("convId") ?: return call.reject("convId required")
        val posted = Notifier.notifyCall(
            context,
            convId,
            call.getString("name") ?: "微信",
            call.getInt("id") ?: DeepLink.requestCode("call_$convId"),
        )
        val ret = JSObject()
        ret.put("posted", posted)
        call.resolve(ret)
    }

    @PluginMethod
    fun cancelNotify(call: PluginCall) {
        val id = call.getInt("id") ?: return call.reject("id required")
        Notifier.cancel(context, id)
        call.resolve()
    }

    // ---------------------------------------------------------- reply queue

    // Two-phase since M-J0: peek → JS dispatches → ack. The old one-shot
    // drainReplies cleared the store BEFORE dispatch, so a process kill in
    // between dropped the whole batch of hand-typed replies.
    @PluginMethod
    fun peekReplies(call: PluginCall) {
        val raw = ReplyQueue.peek(context)
        val ret = JSObject()
        // Hand the parsed array across the bridge; JS revalidates every item
        // anyway (src/native/reply-drain.ts), so a corrupt store degrades to [].
        val arr = try {
            JSONArray(raw)
        } catch (e: Exception) {
            JSONArray()
        }
        ret.put("items", arr)
        call.resolve(ret)
    }

    @PluginMethod
    fun ackReplies(call: PluginCall) {
        val count = call.getInt("count") ?: return call.reject("count required")
        ReplyQueue.ack(context, count)
        call.resolve()
    }

    // -------------------------------------------------------------- battery

    @PluginMethod
    fun batteryIgnored(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val ret = JSObject()
        ret.put("ignored", pm.isIgnoringBatteryOptimizations(context.packageName))
        call.resolve(ret)
    }

    @PluginMethod
    fun requestBatteryIgnore(call: PluginCall) {
        val ret = JSObject()
        try {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            ret.put("launched", true)
        } catch (e: Exception) {
            ret.put("launched", false)
        }
        call.resolve(ret)
    }

    /**
     * Best effort: walk the vendor's known background-manager activities and
     * start the first one that exists on this device, falling back to the stock
     * battery-optimization list, then to our own app-details page. Resolves
     * with which rung of the ladder worked — the wizard page words its guidance
     * accordingly. Never rejects: a missing OEM activity is normal, not an error.
     */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        val candidates = vendorIntents(call.getString("vendor") ?: "")
        val ret = JSObject()
        for ((label, intent) in candidates) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                ret.put("opened", label)
                return call.resolve(ret)
            } catch (e: Exception) {
                /* try the next rung */
            }
        }
        ret.put("opened", "none")
        call.resolve(ret)
    }

    private fun vendorIntents(vendor: String): List<Pair<String, Intent>> {
        val out = mutableListOf<Pair<String, Intent>>()
        val cn = { pkg: String, cls: String -> Intent().setComponent(ComponentName(pkg, cls)) }
        when (vendor) {
            "xiaomi" -> {
                out.add("miui_autostart" to cn("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
                out.add("miui_powerkeeper" to cn("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
                    .putExtra("package_name", context.packageName)
                    .putExtra("package_label", "微信"))
            }
            "huawei" -> {
                out.add("huawei_launch" to cn("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"))
                out.add("huawei_protected" to cn("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"))
            }
            "oppo" -> {
                out.add("oppo_startup" to cn("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"))
                out.add("oppo_startup_old" to cn("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"))
            }
            "vivo" -> {
                out.add("vivo_bg" to cn("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"))
                out.add("vivo_bg_old" to cn("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"))
            }
            "samsung" -> {
                out.add("samsung_care" to cn("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"))
                out.add("samsung_sm" to cn("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"))
            }
            "oneplus" -> {
                out.add("oneplus_chain" to cn("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"))
            }
            "meizu" -> {
                out.add("meizu_sec" to Intent("com.meizu.safe.security.SHOW_APPSEC")
                    .setPackage("com.meizu.safe")
                    .putExtra("packageName", context.packageName))
            }
        }
        // Stock ladder, present on every Android:
        out.add("aosp_battery_list" to Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        out.add("app_details" to Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + context.packageName),
        ))
        return out
    }

    // --------------------------------------------------------------- widget

    @PluginMethod
    fun updateWidget(call: PluginCall) {
        WidgetStore.write(
            context,
            call.getInt("unread") ?: 0,
            call.getString("title") ?: "微信",
            call.getString("preview") ?: "",
            call.getString("convId") ?: "",
            System.currentTimeMillis(),
        )
        AiwxWidgetProvider.pushUpdate(context)
        call.resolve()
    }

    // ------------------------------------------------- 后台唤醒 (M-J4)

    /**
     * Hand Kotlin the next 24h of already-final notification rows.
     *
     * Wholesale replace, never merge: the JS side has just re-derived the world
     * from `scheduled_actions`, and a row it no longer lists must not survive
     * here (that is how a cancelled heartbeat would keep firing forever).
     */
    @PluginMethod
    fun writeWakeSnapshot(call: PluginCall) {
        val items = call.getString("items") ?: "[]"
        Snapshot.write(context, items, System.currentTimeMillis())
        // Arming here (not only in the worker) means a snapshot written seconds
        // before the user swipes the app away still has its alarm set.
        Wake.rearm(context, System.currentTimeMillis())
        WakeWorker.ensureScheduled(context)
        call.resolve()
    }

    /** Diagnostics for 设置→原生增强: what the background half is holding. */
    @PluginMethod
    fun wakeStatus(call: PluginCall) {
        val now = System.currentTimeMillis()
        val res = JSObject()
        res.put("items", Snapshot.items(context).size)
        res.put("fired", Snapshot.firedIds(context).size)
        res.put("writtenAt", Snapshot.writtenAt(context))
        res.put("stale", Snapshot.isStale(context, now))
        res.put("nextFireAt", Snapshot.nextFireAt(context, now) ?: 0L)
        res.put("exactAllowed", exactAlarmsAllowed())
        call.resolve(res)
    }

    /**
     * The user opened that chat: the shade's stacked history is caught up, so
     * drop it — otherwise the next notification would re-show lines they have
     * already read in the app.
     */
    @PluginMethod
    fun clearConversationHistory(call: PluginCall) {
        val convId = call.getString("convId")
        if (convId.isNullOrEmpty()) Conversations.clearAll(context) else Conversations.clear(context, convId)
        call.resolve()
    }

    /**
     * Deliver anything already due, right now. Used by the device test (there
     * is no other way to prove the delivery path works without waiting 15
     * minutes for WorkManager) and by 设置's 「立即检查」.
     */
    @PluginMethod
    fun wakeNow(call: PluginCall) {
        val posted = Wake.deliverDue(context, System.currentTimeMillis())
        val res = JSObject()
        res.put("posted", posted)
        call.resolve(res)
    }

    private fun exactAlarmsAllowed(): Boolean =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            true
        } else {
            val am = context.getSystemService(Context.ALARM_SERVICE) as? android.app.AlarmManager
            am?.canScheduleExactAlarms() ?: false
        }
}
