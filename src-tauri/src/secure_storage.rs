//! Cross-platform secure storage.
//!
//! - **Desktop / iOS**: OS keychain via the `keyring` crate.
//! - **Android**: `EncryptedSharedPreferences` via a Tauri plugin backed by
//!   the Android Keystore (hardware-backed AES-256-GCM).

use std::fmt;
use tauri::Manager;

#[cfg(not(target_os = "android"))]
const SERVICE: &str = "com.jeezman.avark";

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.jeezman.avark";

// -- Error type ---------------------------------------------------------------

#[derive(Debug)]
pub enum Error {
    /// Failed to create or look up a keychain entry.
    #[cfg(not(target_os = "android"))]
    Keyring(keyring::Error),
    /// The Tauri mobile plugin call failed.
    #[cfg(target_os = "android")]
    Plugin(String),
    /// The requested key was not found.
    NotFound(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(not(target_os = "android"))]
            Error::Keyring(e) => write!(f, "keychain error: {e}"),
            #[cfg(target_os = "android")]
            Error::Plugin(msg) => write!(f, "secure storage plugin error: {msg}"),
            Error::NotFound(key) => write!(f, "no value found for key \"{key}\""),
        }
    }
}

impl std::error::Error for Error {}

#[cfg(not(target_os = "android"))]
impl From<keyring::Error> for Error {
    fn from(e: keyring::Error) -> Self {
        Error::Keyring(e)
    }
}

/// A platform-appropriate secure key-value store.
///
/// On desktop/iOS this wraps the OS keychain. On Android it wraps
/// `EncryptedSharedPreferences` accessed through a Tauri mobile plugin.
///
/// Cheap to clone (contains only a reference-counted handle on Android,
/// nothing on other platforms).
#[derive(Clone)]
pub struct SecureStorage {
    #[cfg(target_os = "android")]
    plugin: tauri::plugin::PluginHandle<tauri::Wry>,
    #[cfg(not(target_os = "android"))]
    _priv: (),
}

// -- Construction (retrieve from Tauri managed state) -------------------------

impl SecureStorage {
    pub fn get_instance(app: &tauri::AppHandle) -> &Self {
        app.state::<Self>().inner()
    }
}

// -- Desktop / iOS implementation (keyring) ------------------------------------

#[cfg(not(target_os = "android"))]
impl SecureStorage {
    pub fn get(&self, key: &str) -> Result<Option<String>, Error> {
        let entry = keyring::Entry::new(SERVICE, key)?;
        match entry.get_password() {
            Ok(val) => Ok(Some(val)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), Error> {
        let entry = keyring::Entry::new(SERVICE, key)?;
        entry.set_password(value)?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<(), Error> {
        let entry = keyring::Entry::new(SERVICE, key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

// -- Android implementation (Tauri plugin → EncryptedSharedPreferences) --------

#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct PluginArgs {
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct PluginGetResponse {
    value: Option<String>,
}

#[cfg(target_os = "android")]
impl SecureStorage {
    pub fn get(&self, key: &str) -> Result<Option<String>, Error> {
        let resp: PluginGetResponse = self
            .plugin
            .run_mobile_plugin("get", PluginArgs { key: key.to_string(), value: None })
            .map_err(|e| Error::Plugin(e.to_string()))?;
        Ok(resp.value)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), Error> {
        self.plugin
            .run_mobile_plugin::<()>(
                "set",
                PluginArgs {
                    key: key.to_string(),
                    value: Some(value.to_string()),
                },
            )
            .map_err(|e| Error::Plugin(e.to_string()))
    }

    pub fn delete(&self, key: &str) -> Result<(), Error> {
        self.plugin
            .run_mobile_plugin::<()>(
                "remove",
                PluginArgs { key: key.to_string(), value: None },
            )
            .map_err(|e| Error::Plugin(e.to_string()))
    }
}

// -- Tauri plugin registration ------------------------------------------------

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("secure-storage")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "SecureStoragePlugin")?;
                app.manage(SecureStorage { plugin: handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = _api;
                app.manage(SecureStorage { _priv: () });
            }
            Ok(())
        })
        .build()
}
