use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::RwLock;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    onboarding_seen: bool,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("failed to resolve app data directory")]
    NoDataDir,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
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

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|_| AppError::NoDataDir)?;
    Ok(dir.join("settings.json"))
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
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SettingsLock(RwLock::new(())))
        .invoke_handler(tauri::generate_handler![greet, has_seen_onboarding, set_onboarding_seen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
