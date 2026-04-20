//! Native share-sheet bridge.
//!
//! Android's WebView doesn't expose `navigator.share`, so the frontend falls
//! back to this command which bounces through JNI into `MainActivity.shareText`
//! and fires an `ACTION_SEND` intent. iOS gets `navigator.share` natively and
//! never calls this; non-mobile platforms currently return an error.

#[tauri::command]
pub async fn share_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        share_text_android(&text).map_err(|e| format!("shareText failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = text;
        Err("share_text is only implemented on Android".to_string())
    }
}

#[cfg(target_os = "android")]
fn share_text_android(text: &str) -> Result<(), jni::errors::Error> {
    use jni::objects::{JClass, JObject, JValue};
    use jni::JavaVM;

    let ctx = ndk_context::android_context();
    // SAFETY: JavaVM pointer from ndk-context is valid for the process.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast())? };
    let mut env = vm.attach_current_thread()?;

    // Same class-loader dance as dismiss_android_splash: find MainActivity via
    // the app ClassLoader rather than the system loader.
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

    let j_text = env.new_string(text)?;
    env.call_static_method(
        &class,
        "shareText",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&j_text)],
    )?;
    Ok(())
}
