mod ark;
mod secure_storage;
mod wallet;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

#[derive(Debug, Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    onboarding_seen: bool,
    #[serde(default)]
    asp_url: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WalletData {
    asp_url: String,
    network: String,
}

struct ArkClientState(RwLock<Option<ark::ArkClient>>);

/// Guards wallet creation so only one can run at a time.
struct WalletCreationLock(tokio::sync::Mutex<()>);

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

fn boarding_db_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app_data_file(app, "boarding_outputs.json")
}

const MNEMONIC_KEY: &str = "wallet-mnemonic";

fn store_mnemonic(store: &secure_storage::SecureStorage, mnemonic: &str) -> Result<(), AppError> {
    store.set(MNEMONIC_KEY, mnemonic)?;
    Ok(())
}

fn load_mnemonic(store: &secure_storage::SecureStorage) -> Result<String, AppError> {
    store
        .get(MNEMONIC_KEY)?
        .ok_or_else(|| secure_storage::Error::NotFound(MNEMONIC_KEY.into()).into())
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
    info!(url = %url, "connecting to ASP");

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

    info!(network = %info.network, version = %info.version, "ASP connected");

    // Persist ASP URL and network on successful connection
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

#[tauri::command]
async fn has_wallet(app: tauri::AppHandle) -> Result<bool, AppError> {
    let path = wallet_path(&app)?;
    Ok(tokio::fs::try_exists(&path).await?)
}

/// Build and connect an Ark client from an Xpriv and ASP URL.
async fn build_ark_client(
    app: &tauri::AppHandle,
    xpriv: bitcoin::bip32::Xpriv,
    asp_url: &str,
) -> Result<ark::ArkClient, AppError> {
    debug!(asp_url = %asp_url, "building Ark client");

    // Fetch server info to get the server public key for the boarding DB.
    let mut grpc = ark_grpc::Client::new(asp_url.to_string());
    tokio::time::timeout(Duration::from_secs(10), grpc.connect())
        .await
        .map_err(|_| AppError::Asp("Connection timed out".into()))?
        .map_err(|e| AppError::Asp(format!("Connection failed: {e}")))?;
    let server_info = tokio::time::timeout(Duration::from_secs(10), grpc.get_info())
        .await
        .map_err(|_| AppError::Asp("Server info request timed out".into()))?
        .map_err(|e| AppError::Asp(format!("Failed to get server info: {e}")))?;
    let (server_pk, _parity) = server_info.signer_pk.x_only_public_key();
    let network = server_info.network;

    let secp = bitcoin::key::Secp256k1::new();
    let esplora = ark::esplora_url(network);

    let db_path = boarding_db_path(app)?;
    let store = secure_storage::SecureStorage::get_instance(app).clone();
    let db = tokio::task::spawn_blocking(move || {
        ark::FileDb::load(db_path, network, server_pk, store)
    })
        .await
        .map_err(|e| AppError::Wallet(format!("Boarding DB task panicked: {e}")))?
        .map_err(|e| AppError::Wallet(format!("Failed to load boarding DB: {e}")))?;
    let bdk_wallet = ark_bdk_wallet::Wallet::new_from_xpriv(
        xpriv,
        secp,
        network,
        esplora,
        db,
    )
    .map_err(|e| AppError::Wallet(format!("Failed to create BDK wallet: {e}")))?;

    let blockchain = ark::EsploraBlockchain::new(esplora)
        .map_err(|e| AppError::Wallet(format!("Failed to create blockchain client: {e}")))?;

    let swap_storage = Arc::new(ark_client::InMemorySwapStorage::default());

    let offline_client =
        ark_client::OfflineClient::<_, _, _, ark_client::Bip32KeyProvider>::new_with_bip32(
            "avark".to_string(),
            xpriv,
            None,
            Arc::new(blockchain),
            Arc::new(bdk_wallet),
            asp_url.to_string(),
            swap_storage,
            "https://api.boltz.exchange/v2".to_string(),
            Duration::from_secs(30),
        );

    // The OfflineClient already applies per-operation timeouts internally (via
    // `timeout_op`), so no outer timeout is needed here.
    let client = offline_client
        .connect()
        .await
        .map_err(|e| AppError::Asp(format!("Failed to connect to ASP: {e}")))?;

    Ok(client)
}

#[derive(Serialize)]
struct CreateWalletResult {
    mnemonic: String,
}

#[tauri::command]
async fn create_wallet(app: tauri::AppHandle) -> Result<CreateWalletResult, AppError> {
    info!("creating new wallet");

    // Serialize wallet creation to prevent double-click races.
    let creation_lock = app.state::<WalletCreationLock>();
    let _guard = creation_lock.0.lock().await;

    // Bail if a wallet already exists (second concurrent call, or re-invocation).
    let path = wallet_path(&app)?;
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        warn!("wallet already exists, aborting creation");
        return Err(AppError::Wallet("Wallet already exists".into()));
    }

    // Read ASP URL and network from settings
    let (asp_url, network) = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        let settings = read_settings(&app).await?;
        let url = settings
            .asp_url
            .ok_or_else(|| AppError::Wallet("No ASP URL configured. Connect to an ASP first.".into()))?;
        let net_str = settings
            .network
            .ok_or_else(|| AppError::Wallet("No network configured. Connect to an ASP first.".into()))?;
        let network = net_str.parse::<bitcoin::Network>()
            .map_err(|e| AppError::Wallet(format!("Invalid network \"{net_str}\": {e}")))?;
        (url, network)
    };

    // Generate mnemonic and derive keys
    let secret = wallet::generate_mnemonic()
        .map_err(|e| AppError::Wallet(e.to_string()))?;
    let mnemonic_words = secret.words().to_owned();

    let mut seed = secret.mnemonic().to_seed("");
    let xpriv = bitcoin::bip32::Xpriv::new_master(network, &seed)
        .map_err(|e| AppError::Wallet(format!("Key derivation failed: {e}")))?;
    zeroize::Zeroize::zeroize(&mut seed);


    // Connect to ASP
    let client = build_ark_client(&app, xpriv, &asp_url).await?;

    // Store mnemonic in secure storage (OS keychain / Android EncryptedSharedPreferences)
    let store = secure_storage::SecureStorage::get_instance(&app);
    store_mnemonic(&store, &mnemonic_words)?;

    // Persist non-secret wallet metadata to disk
    let wallet_data = WalletData {
        asp_url,
        network: network.to_string(),
    };
    let path = wallet_path(&app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let data = serde_json::to_string_pretty(&wallet_data)?;
    tokio::fs::write(&path, data).await?;

    // Store client in app state
    let ark_state = app.state::<ArkClientState>();
    *ark_state.0.write().await = Some(client);

    info!("wallet created successfully");

    Ok(CreateWalletResult {
        mnemonic: mnemonic_words,
    })
}

#[tauri::command]
async fn get_mnemonic(app: tauri::AppHandle) -> Result<String, AppError> {
    let store = secure_storage::SecureStorage::get_instance(&app);
    load_mnemonic(store)
}

#[tauri::command]
async fn is_wallet_loaded(app: tauri::AppHandle) -> bool {
    let state = app.state::<ArkClientState>();
    let loaded = state.0.read().await.is_some();
    loaded
}

#[tauri::command]
async fn load_wallet(app: tauri::AppHandle) -> Result<(), AppError> {
    info!("loading existing wallet");

    // If the client is already initialized, nothing to do.
    let ark_state = app.state::<ArkClientState>();
    if ark_state.0.read().await.is_some() {
        debug!("Ark client already initialized, skipping load");
        return Ok(());
    }

    // Read wallet metadata from disk.
    let path = wallet_path(&app)?;
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to read wallet.json: {e}")))?;
    let wallet_data: WalletData = serde_json::from_str(&raw)?;

    let network = wallet_data.network.parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network \"{}\": {e}", wallet_data.network)))?;

    // Load mnemonic from secure storage and derive keys.
    let store = secure_storage::SecureStorage::get_instance(&app);
    let mnemonic_words = load_mnemonic(store)?;
    let mnemonic = bip39::Mnemonic::parse_normalized(&mnemonic_words)
        .map_err(|e| AppError::Wallet(format!("Invalid stored mnemonic: {e}")))?;

    let mut seed = mnemonic.to_seed("");
    let xpriv = bitcoin::bip32::Xpriv::new_master(network, &seed)
        .map_err(|e| AppError::Wallet(format!("Key derivation failed: {e}")))?;
    zeroize::Zeroize::zeroize(&mut seed);

    // Rebuild and connect the Ark client.
    let client = build_ark_client(&app, xpriv, &wallet_data.asp_url).await?;

    *ark_state.0.write().await = Some(client);

    info!("wallet loaded successfully");
    Ok(())
}

#[tauri::command]
async fn delete_wallet(app: tauri::AppHandle) -> Result<(), AppError> {
    warn!("deleting wallet data");

    // Clear the in-memory Ark client.
    let ark_state = app.state::<ArkClientState>();
    *ark_state.0.write().await = None;

    let store = secure_storage::SecureStorage::get_instance(&app);
    store.delete(MNEMONIC_KEY)?;

    for path in [wallet_path(&app)?, boarding_db_path(&app)?] {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }

    // Reset onboarding flag so the user goes through setup again.
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;
    settings.onboarding_seen = false;
    settings.asp_url = None;
    settings.network = None;
    write_settings(&app, &settings).await?;

    info!("wallet data deleted");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(secure_storage::init())
        .manage(SettingsLock(RwLock::new(())))
        .manage(ArkClientState(RwLock::new(None)))
        .manage(WalletCreationLock(tokio::sync::Mutex::new(())))
        .invoke_handler(tauri::generate_handler![has_seen_onboarding, set_onboarding_seen, has_wallet, connect_asp, create_wallet, is_wallet_loaded, load_wallet, get_mnemonic, delete_wallet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
