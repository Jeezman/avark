//! Splash-screen coordination with the Android side.
//!
//! The system SplashScreen (installed in `MainActivity.kt`) holds the orange
//! anteater graphic on screen until `keepSplash` flips to `false`. That flip
//! happens when either (a) the frontend calls `splash_ready` after React has
//! painted — the common case — or (b) the Kotlin-side failsafe fires after
//! `SPLASH_FAILSAFE_MS`.
//!
//! Rationale: on some Samsung Android 14+ kernels the ART heap-compaction
//! fallback stalls the process for 10–30+ seconds between WebView first-frame
//! and meaningful JS execution. Without holding the splash, the user sees a
//! blank white viewport during that window. See `todo.md`.

/// Tell the Android splash screen it can go away now. Invoked from the
/// frontend once React has mounted and painted real content. No-op on
/// non-Android platforms so the same frontend code works everywhere.
#[tauri::command]
pub async fn splash_ready() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        dismiss_android_splash().map_err(|e| format!("dismissSplash failed: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn dismiss_android_splash() -> Result<(), jni::errors::Error> {
    use jni::objects::{JClass, JObject, JValue};
    use jni::JavaVM;

    // SAFETY: ndk-context exposes a JavaVM pointer that lives for the whole
    // process lifetime. Wrapping it here never outlives the VM itself.
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast())? };
    let mut env = vm.attach_current_thread()?;

    // `env.find_class("...")` fails from a Rust-attached thread — its default
    // ClassLoader is the system loader, which has no idea about app classes.
    // We reach the app ClassLoader by calling `getClassLoader()` on our
    // Android Context, then using that to `loadClass("...MainActivity")`.
    //
    // SAFETY: `ctx.context()` is a long-lived Android Context jobject managed
    // by the Android runtime. `JObject` is a transparent wrapper with no Drop
    // impl, so wrapping this borrowed ref doesn't risk releasing it.
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    let class_loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;

    let class_name = env.new_string("com.jeezman.avark.MainActivity")?;
    let class_obj = env
        .call_method(
            &class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&class_name)],
        )?
        .l()?;

    let class: JClass = class_obj.into();
    env.call_static_method(&class, "dismissSplash", "()V", &[])?;
    Ok(())
}
