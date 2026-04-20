package com.jeezman.avark

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Max time the system splash can stay on screen before we auto-dismiss it,
 * even if the frontend never calls `splash_ready`. Protects against a
 * broken JS bundle stranding the user on the splash forever.
 */
private const val SPLASH_FAILSAFE_MS = 30_000L

class MainActivity : TauriActivity() {
    companion object {
        // Kept `true` while the splash should stay visible. The Rust side
        // flips this to `false` via JNI from the `splash_ready` command.
        // AtomicBoolean because `setKeepOnScreenCondition` reads it from the
        // UI thread while the JNI call will arrive on whatever thread Rust
        // happens to be on.
        private val keepSplash = AtomicBoolean(true)

        // Weak reference to the running Activity so JNI helpers (which run
        // off the UI thread) can post back to it.
        @Volatile
        private var instance: MainActivity? = null

        @JvmStatic
        fun dismissSplash() {
            keepSplash.set(false)
        }

        /**
         * Launch the system share sheet with `text`. Android WebView doesn't
         * expose `navigator.share`, so the frontend falls through to a Tauri
         * command that calls into here via JNI. Must be dispatched to the UI
         * thread because startActivity requires it.
         */
        @JvmStatic
        fun shareText(text: String) {
            val activity = instance ?: return
            activity.runOnUiThread {
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                activity.startActivity(Intent.createChooser(intent, null))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Install splash BEFORE super.onCreate so the SplashScreen API can
        // swap the activity theme back to the app theme at the right moment.
        val splashScreen = installSplashScreen()
        splashScreen.setKeepOnScreenCondition { keepSplash.get() }

        // Failsafe so a JS regression can't strand the user.
        Handler(Looper.getMainLooper()).postDelayed(
            { keepSplash.set(false) },
            SPLASH_FAILSAFE_MS,
        )

        instance = this
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }
}
