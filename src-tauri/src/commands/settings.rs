use serde::Serialize;
use tauri::Manager;

use crate::{read_settings, write_settings, AppError, SettingsLock, Theme};

#[derive(Serialize)]
pub struct SettingsInfo {
    pub asp_url: Option<String>,
    pub network: Option<String>,
    pub theme: Option<Theme>,
    pub esplora_url: Option<String>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn settings(app: tauri::AppHandle) -> Result<SettingsInfo, AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.read().await;
    let s = read_settings(&app).await?;
    Ok(SettingsInfo {
        asp_url: s.asp_url,
        network: s.network,
        theme: s.theme,
        esplora_url: s.esplora_url,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_theme(app: tauri::AppHandle, theme: Theme) -> Result<(), AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut s = read_settings(&app).await?;
    s.theme = Some(theme);
    write_settings(&app, &s).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_esplora_url(app: tauri::AppHandle, url: Option<String>) -> Result<(), AppError> {
    if let Some(ref u) = url {
        if !u.is_empty() {
            let parsed =
                url::Url::parse(u).map_err(|e| AppError::Wallet(format!("Invalid URL: {e}")))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(AppError::Wallet("URL scheme must be http or https".into()));
            }
        }
    }
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut s = read_settings(&app).await?;
    s.esplora_url = url.filter(|u| !u.is_empty());
    write_settings(&app, &s).await
}
