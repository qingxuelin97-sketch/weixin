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

    @PluginMethod
    fun drainReplies(call: PluginCall) {
        val raw = ReplyQueue.drain(context)
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
}
