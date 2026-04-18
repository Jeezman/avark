package com.jeezman.avark

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

        @JvmStatic
        fun dismissSplash() {
            keepSplash.set(false)
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

        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }
}
