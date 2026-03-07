mod wallet;

use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::RwLock;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    onboarding_seen: bool,
    #[serde(default)]
    asp_url: Option<String>,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("failed to resolve app data directory")]
    NoDataDir,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("ASP connection failed: {0}")]
    Asp(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

struct SettingsLock(RwLock<()>);

fn app_data_file(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|_| AppError::NoDataDir)?;
    Ok(dir.join(filename))
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "settings.json")
}

fn wallet_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "wallet.json")
}

async fn read_settings(app: &tauri::AppHandle) -> Result<Settings, AppError> {
    let path = config_path(app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}

async fn write_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), AppError> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let data = serde_json::to_string_pretty(settings)?;
    tokio::fs::write(&path, data).await?;
    Ok(())
}


#[tauri::command]
async fn has_seen_onboarding(app: tauri::AppHandle) -> Result<bool, AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.read().await;
    let settings = read_settings(&app).await?;
    Ok(settings.onboarding_seen)
}

#[tauri::command]
async fn set_onboarding_seen(app: tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;
    settings.onboarding_seen = true;
    write_settings(&app, &settings).await
}

#[derive(Serialize)]
struct AspInfo {
    network: String,
    version: String,
}

#[tauri::command]
async fn connect_asp(app: tauri::AppHandle, url: String) -> Result<AspInfo, AppError> {
    let parsed = url::Url::parse(&url)
        .map_err(|e| AppError::Asp(format!("Invalid URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::Asp("URL scheme must be http or https".into()));
    }
    if parsed.host().is_none() {
        return Err(AppError::Asp("URL must include a host".into()));
    }

    let mut client = ark_grpc::Client::new(url.clone());

    tokio::time::timeout(std::time::Duration::from_secs(10), client.connect())
        .await
        .map_err(|_| AppError::Asp("Connection timed out — is the URL correct?".into()))?
        .map_err(|e| AppError::Asp(format!("Connection failed: {e}")))?;

    let info = tokio::time::timeout(std::time::Duration::from_secs(10), client.get_info())
        .await
        .map_err(|_| AppError::Asp("Server info request timed out".into()))?
        .map_err(|e| AppError::Asp(format!("Failed to get server info: {e}")))?;

    // Persist ASP URL on successful connection
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;
    settings.asp_url = Some(url);
    write_settings(&app, &settings).await?;

    Ok(AspInfo {
        network: info.network.to_string(),
        version: info.version,
    })
}

#[tauri::command]
async fn has_wallet(app: tauri::AppHandle) -> Result<bool, AppError> {
    let path = wallet_path(&app)?;
    Ok(tokio::fs::try_exists(&path).await.map_err(|e| {
        eprintln!("Wallet check error: {e}");
        e
    }).unwrap_or(false))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SettingsLock(RwLock::new(())))
        .invoke_handler(tauri::generate_handler![has_seen_onboarding, set_onboarding_seen, has_wallet, connect_asp])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
