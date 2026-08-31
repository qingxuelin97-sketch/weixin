package com.personal.weixinai.aiwx

import android.util.Log
import com.getcapacitor.JSObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject

/**
 * Streaming HTTP for the LLM layer (M-J5). CapacitorHttp buffers whole
 * responses and cannot be aborted from JS, which is why native never streamed;
 * this class runs the POST on OkHttp, reads the response line by line on
 * OkHttp's own background thread, and fires each line at the WebView through
 * the plugin's `sseLine` event channel (multiplexed by `id`).
 *
 * Event protocol (mirrored in src/native/sse-bridge.ts — change both or none):
 *   { id, open: true, status }   response head arrived
 *   { id, line }                 one raw response line, newline stripped
 *   { id, done: true, status }   server closed the stream normally
 *   { id, error }                any failure, including cancel and timeouts
 *
 * Deliberately NOT part of AiwxNativePlugin: the plugin class stays a thin
 * @PluginMethod façade (it is 280+ lines of forwarding already), and this
 * class owns every OkHttp detail so it can be reasoned about in one screen.
 *
 * The JS side treats a silent bridge as an error (its pulls race rejecting
 * timers), so this class prefers ALWAYS emitting a terminal event over being
 * clever: every path out of a connection ends in exactly one done/error emit.
 */
class SseBridge(private val emit: (JSObject) -> Unit) {

    companion object {
        private const val TAG = "AIWX-SSE"

        /** TCP+TLS establishment budget. */
        private const val CONNECT_TIMEOUT_S = 20L

        /**
         * Max silence BETWEEN bytes, not a whole-call cap: a model that thinks
         * for 50s then streams for 5 minutes is fine; one that sends nothing
         * for 60s is dead. (OkHttp's default read timeout is 10s — far too
         * tight for reasoning models — which is why it is pinned explicitly.)
         */
        private const val READ_TIMEOUT_S = 60L
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_S, TimeUnit.SECONDS)
            // No call-level cap: the stream is as long as the reply is.
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    /** Live connections by request id; used for cancel and destroy-all. */
    private val calls = ConcurrentHashMap<String, Call>()

    /**
     * Start one streaming POST. Never throws for expected conditions — a bad
     * URL/JSON or a transport failure becomes an `error` event for [id], so
     * the JS promise chain has exactly one failure surface to watch.
     */
    fun start(id: String, url: String, headersJson: String, bodyJson: String) {
        val request = try {
            val builder = Request.Builder().url(url)
            val headers = JSONObject(headersJson)
            val names = headers.keys()
            while (names.hasNext()) {
                val name = names.next()
                builder.header(name, headers.optString(name))
            }
            // The body crosses the bridge as the EXACT string JS serialized —
            // re-encoding through JSObject would mangle large ints and drop
            // key order, and byte-identical bodies are what prompt caches key on.
            builder.post(bodyJson.toRequestBody("application/json; charset=utf-8".toMediaType()))
            builder.build()
        } catch (e: Exception) {
            emitError(id, "bad request: " + (e.message ?: e.javaClass.simpleName))
            return
        }
        val call = client.newCall(request)
        calls[id] = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                calls.remove(id)
                emitError(id, e.message ?: "io error")
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use { resp ->
                        // Head first: JS learns the status BEFORE any line, so a
                        // 4xx can be collected as an error body and classified
                        // (bad_model self-heal needs the message, not just 401).
                        val open = JSObject()
                        open.put("id", id)
                        open.put("open", true)
                        open.put("status", resp.code)
                        emit(open)
                        val source = resp.body?.source()
                        if (source != null) {
                            while (true) {
                                val line = source.readUtf8Line() ?: break
                                val ev = JSObject()
                                ev.put("id", id)
                                ev.put("line", line)
                                emit(ev)
                            }
                        }
                        val done = JSObject()
                        done.put("id", id)
                        done.put("done", true)
                        done.put("status", resp.code)
                        emit(done)
                    }
                } catch (e: Exception) {
                    // Read timeout, connection reset, and our own cancel() all
                    // land here. JS distinguishes user-abort from breakage by
                    // its own signal state, so one error shape is enough.
                    emitError(id, e.message ?: "read error")
                } finally {
                    calls.remove(id)
                }
            }
        })
    }

    /** Close one connection. The reader thread then fails and emits `error`. */
    fun cancel(id: String) {
        calls.remove(id)?.cancel()
        Log.i(TAG, "cancel $id")
    }

    /** Plugin teardown: close everything — leaked sockets outlive WebViews. */
    fun destroy() {
        for ((_, call) in calls) call.cancel()
        calls.clear()
    }

    private fun emitError(id: String, message: String) {
        Log.w(TAG, "error $id: $message")
        val ev = JSObject()
        ev.put("id", id)
        ev.put("error", message)
        emit(ev)
    }
}
