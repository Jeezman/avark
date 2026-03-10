package com.jeezman.avark

import android.app.Activity
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class KeyValueArgs {
    lateinit var key: String
    var value: String? = null
}

@TauriPlugin
class SecureStoragePlugin(private val activity: Activity) : Plugin(activity) {

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(activity)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            activity,
            "avark_secure_storage",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    @Command
    fun get(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyValueArgs::class.java)
            val value = prefs.getString(args.key, null)
            val result = JSObject()
            if (value != null) {
                result.put("value", value)
            }
            invoke.resolve(result)
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }

    @Command
    fun set(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyValueArgs::class.java)
            if (!prefs.edit().putString(args.key, args.value).commit()) {
                invoke.reject("Failed to write to secure storage")
                return
            }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }

    @Command
    fun remove(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyValueArgs::class.java)
            if (!prefs.edit().remove(args.key).commit()) {
                invoke.reject("Failed to remove from secure storage")
                return
            }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }
}
