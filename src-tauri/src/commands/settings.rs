use serde::Serialize;
use tauri::Manager;

use crate::{read_settings, write_settings, AppError, SettingsLock, Theme};

const SUPPORTED_FIAT_CODES: &[&str] = &[
    "USD", "JPY", "CNY", "SGD", "HKD", "CAD", "NZD", "AUD", "CLP", "GBP", "DKK", "SEK", "ISK",
    "CHF", "BRL", "EUR", "RUB", "PLN", "THB", "KRW", "TWD", "CZK", "HUF", "INR", "TRY", "NGN",
    "ARS", "ILS", "LBP", "MYR", "UAH", "JMD", "COP", "MXN", "VES", "TZS", "QAR", "TND", "NOK",
    "AED", "TTD", "PHP", "IDR", "RON", "CDF", "XAF", "XOF", "KES", "UGX", "ZAR", "CUP", "DOP",
    "BZD", "BOB", "CRC", "GTQ", "NIO", "PYG", "UYU", "MRU", "ALL", "ANG", "AOA", "BDT", "BGN",
    "BHD", "BIF", "BMD", "BWP", "DJF", "DZD", "EGP", "ETB", "GEL", "GHS", "GNF", "HNL", "IRR",
    "JOD", "KGS", "KZT", "LKR", "MAD", "MGA", "NAD", "NPR", "PAB", "PEN", "PKR", "RSD", "RWF",
    "UZS", "VND", "ZMW", "MWK", "LSL", "SZL", "SAR", "OMR", "XAU", "XAG",
];

#[derive(Serialize)]
pub struct SettingsInfo {
    pub asp_url: Option<String>,
    pub network: Option<String>,
    pub theme: Option<Theme>,
    pub esplora_url: Option<String>,
    pub fiat_enabled: bool,
    pub fiat_currency: String,
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
        fiat_enabled: s.fiat_enabled.unwrap_or(true),
        fiat_currency: s.fiat_currency.unwrap_or_else(|| "USD".to_string()),
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
pub async fn set_fiat_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut s = read_settings(&app).await?;
    s.fiat_enabled = Some(enabled);
    write_settings(&app, &s).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_fiat_currency(app: tauri::AppHandle, currency: String) -> Result<(), AppError> {
    let code = currency.to_uppercase();
    if !SUPPORTED_FIAT_CODES.contains(&code.as_str()) {
        return Err(AppError::Wallet(format!(
            "Unsupported fiat currency: {code}"
        )));
    }
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut s = read_settings(&app).await?;
    s.fiat_currency = Some(code);
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
