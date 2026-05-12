mod ark;
mod commands;
mod lendaswap;
mod secure_storage;
mod wallet;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::sync::RwLock;
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Theme {
    Dark,
    Light,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Settings {
    #[serde(default)]
    pub(crate) onboarding_seen: bool,
    #[serde(default)]
    pub(crate) asp_url: Option<String>,
    #[serde(default)]
    pub(crate) network: Option<String>,
    #[serde(default)]
    pub(crate) theme: Option<Theme>,
    #[serde(default)]
    pub(crate) esplora_url: Option<String>,
    #[serde(default)]
    pub(crate) pin_hash: Option<String>,
    #[serde(default)]
    pub(crate) pin_salt: Option<String>,
    #[serde(default)]
    pub(crate) max_pin_attempts: Option<u32>,
    #[serde(default)]
    pub(crate) pin_failed_attempts: Option<u32>,
    #[serde(default)]
    pub(crate) fiat_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) fiat_currency: Option<String>,
}

pub(crate) struct AppWalletState {
    pub(crate) client: Arc<ark::ArkClient>,
    pub(crate) wallet: Arc<ark::ArkWallet>,
    pub(crate) swap_storage: Arc<ark_client::SqliteSwapStorage>,
    pub(crate) key_provider: Arc<ark_client::Bip32KeyProvider>,
    pub(crate) _sync_cancel: tokio::sync::watch::Sender<()>,
    /// Cancellation token for all background tasks tied to this wallet session.
    /// When the wallet is deleted/replaced, the sender is dropped and all
    /// receivers see the channel close.
    pub(crate) wallet_cancel: tokio::sync::watch::Sender<()>,
}
pub(crate) struct GlobalWalletState(pub(crate) RwLock<Option<AppWalletState>>);

/// Guards wallet creation so only one can run at a time.
pub(crate) struct WalletCreationLock(pub(crate) tokio::sync::Mutex<()>);

/// Interval for background onchain wallet sync.
pub(crate) const ONCHAIN_SYNC_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub(crate) enum AppError {
    #[error("failed to resolve app data directory")]
    NoDataDir,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("ASP connection failed: {0}")]
    Asp(String),
    #[error("Wallet error: {0}")]
    Wallet(String),
    #[error("Secure storage error: {0}")]
    SecureStorage(#[from] secure_storage::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub(crate) struct SettingsLock(pub(crate) RwLock<()>);

pub(crate) fn app_data_file(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|_| AppError::NoDataDir)?;
    Ok(dir.join(filename))
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "settings.json")
}

pub(crate) fn wallet_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "wallet.json")
}

pub(crate) fn boarding_db_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "boarding_outputs.json")
}

pub(crate) fn swap_db_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "swaps.db")
}

pub(crate) fn lendaswap_db_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "lendaswap.db")
}

pub(crate) const MNEMONIC_KEY: &str = "wallet-mnemonic";

pub(crate) fn store_mnemonic(
    store: &secure_storage::SecureStorage,
    mnemonic: &str,
) -> Result<(), AppError> {
    store.set(MNEMONIC_KEY, mnemonic)?;
    Ok(())
}

pub(crate) fn load_mnemonic(store: &secure_storage::SecureStorage) -> Result<String, AppError> {
    store
        .get(MNEMONIC_KEY)?
        .ok_or_else(|| secure_storage::Error::NotFound(MNEMONIC_KEY.into()).into())
}

pub(crate) async fn read_settings(app: &tauri::AppHandle) -> Result<Settings, AppError> {
    let path = config_path(app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}

pub(crate) async fn write_settings(
    app: &tauri::AppHandle,
    settings: &Settings,
) -> Result<(), AppError> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let data = serde_json::to_string_pretty(settings)?;
    // Atomic write: write to a temp file then rename
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, data).await?;
    tokio::fs::rename(&tmp, &path).await?;
    Ok(())
}

// ── Onboarding commands ─────────────────────────────────────────────────

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
    info!(url = %url, "connecting to ASP");

    let parsed = url::Url::parse(&url).map_err(|e| AppError::Asp(format!("Invalid URL: {e}")))?;
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

    info!(network = %info.network, version = %info.version, "ASP connected");

    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;
    settings.asp_url = Some(url);
    settings.network = Some(info.network.to_string());
    write_settings(&app, &settings).await?;

    Ok(AspInfo {
        network: info.network.to_string(),
        version: info.version,
    })
}

// ── App entry point ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "avark_lib=info".parse().unwrap()),
        )
        .try_init()
        .ok();

    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(secure_storage::init())
        .manage(SettingsLock(RwLock::new(())))
        .manage(GlobalWalletState(RwLock::new(None)))
        .manage(WalletCreationLock(tokio::sync::Mutex::new(())))
        .manage(commands::receive::ReceiveSubscriptionState(
            tokio::sync::Mutex::new(None),
        ))
        .setup(|app| {
            // Open the swap records DB. Failure here leaves avark's core
            // wallet features fully functional; the Swap tab will fail loudly
            // on first IPC call. The frontend reconciliation logic surfaces
            // that as a user-visible error (`formatLendaSwapError`).
            let handle = app.handle().clone();
            match lendaswap_db_path(&handle) {
                Ok(db_path) => match tauri::async_runtime::block_on(lendaswap::init(&db_path)) {
                    Ok(pool) => {
                        app.manage(lendaswap::LendaSwapDb(pool));
                    }
                    Err(e) => {
                        tracing::error!(
                            error = %e,
                            path = %db_path.display(),
                            "lendaswap db init failed — swap commands will error"
                        );
                    }
                },
                Err(e) => {
                    tracing::error!(
                        error = %e,
                        "failed to resolve lendaswap db path — swap commands will error"
                    );
                }
            };
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Onboarding
            has_seen_onboarding,
            set_onboarding_seen,
            connect_asp,
            // Settings
            commands::settings::settings,
            commands::settings::set_theme,
            commands::settings::set_esplora_url,
            commands::settings::set_fiat_enabled,
            commands::settings::set_fiat_currency,
            // Wallet lifecycle
            commands::wallet::has_wallet,
            commands::wallet::create_wallet,
            commands::wallet::restore_wallet,
            commands::wallet::load_wallet_local,
            commands::wallet::is_wallet_loaded,
            commands::wallet::connect_wallet,
            commands::wallet::delete_wallet,
            // Wallet data
            commands::wallet::get_balance,
            commands::wallet::get_transactions,
            commands::wallet::get_mnemonic,
            commands::wallet::get_receive_address,
            commands::wallet::settle,
            // Coins / VTXOs
            commands::coins::get_vtxos,
            commands::coins::estimate_renew_fees,
            commands::coins::renew_vtxos,
            // Lightning / swaps
            commands::lightning::get_ln_invoice,
            commands::lightning::debug_list_swaps,
            commands::lightning::retry_claim_swap,
            commands::lightning::list_pending_submarine_swaps,
            commands::lightning::refund_submarine_swap,
            // LendaSwap — DB-only, TS SDK handles network calls
            commands::lendaswap::insert_lendaswap_swap,
            commands::lendaswap::update_lendaswap_swap_status,
            commands::lendaswap::dismiss_lendaswap_swap,
            commands::lendaswap::get_lendaswap_swap,
            commands::lendaswap::list_lendaswap_swaps,
            commands::lendaswap::get_lendaswap_xprv,
            // Receive subscription
            commands::receive::start_receive_subscription,
            commands::receive::stop_receive_subscription,
            // Send
            commands::send::detect_address_type,
            commands::send::send_lightning,
            commands::send::send_ark,
            commands::send::send_onchain,
            commands::send::estimate_onchain_send_fee,
            // PIN security
            commands::pin::get_pin_status,
            commands::pin::set_pin,
            commands::pin::verify_pin,
            commands::pin::clear_pin,
            commands::pin::set_max_pin_attempts,
            commands::wallet::verify_mnemonic,
            // Splash
            commands::splash::splash_ready,
            // Share
            commands::share::share_text,
            // Round schedule
            commands::wallet::get_round_schedule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
