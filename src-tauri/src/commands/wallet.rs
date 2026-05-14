use bitcoin::hashes::Hash as _;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tracing::{debug, info, warn};

use super::lightning::{spawn_pending_swap_recovery, BOLTZ_URL};
use crate::{
    ark, boarding_db_path, lendaswap_db_path, load_mnemonic, read_settings, secure_storage,
    store_mnemonic, swap_db_path, wallet, wallet_path, write_settings, AppError, AppWalletState,
    GlobalWalletState, SettingsLock, WalletCreationLock, MNEMONIC_KEY, ONCHAIN_SYNC_INTERVAL,
};

#[derive(Debug, Serialize, serde::Deserialize)]
struct WalletData {
    asp_url: String,
    network: String,
}

async fn read_wallet_data(app: &tauri::AppHandle) -> Result<WalletData, AppError> {
    let path = wallet_path(app)?;
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to read wallet.json: {e}")))?;
    Ok(serde_json::from_str(&raw)?)
}

fn derive_wallet_xpriv(
    app: &tauri::AppHandle,
    wallet_data: &WalletData,
) -> Result<bitcoin::bip32::Xpriv, AppError> {
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| {
            AppError::Wallet(format!("Invalid network \"{}\": {e}", wallet_data.network))
        })?;

    let store = secure_storage::SecureStorage::get_instance(app);
    let mnemonic_words = load_mnemonic(store)?;
    wallet::derive_master_xpriv(&mnemonic_words, network)
        .map_err(|e| AppError::Wallet(e.to_string()))
}

/// Convert a raw sync error into a short, user-facing message.
/// The full error is already logged via `warn!`.
fn friendly_sync_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("429") || lower.contains("too many requests") || lower.contains("rate") {
        "Onchain sync paused — rate limited by block explorer. Will retry automatically.".into()
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "Onchain sync failed — request timed out. Will retry automatically.".into()
    } else if lower.contains("connection")
        || lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("incompletemessage")
        || lower.contains("incomplete message")
        || lower.contains("reset by peer")
        || lower.contains("ssl")
        || lower.contains("tls")
        || lower.contains("handshake")
    {
        "Onchain sync failed — network error. Check your connection.".into()
    } else {
        "Onchain sync failed — will retry automatically.".into()
    }
}

/// Minimum interval between UI error notifications for consecutive sync failures.
const ERROR_NOTIFY_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Number of *consecutive* background sync failures before the first UI toast.
///
/// A single failure is almost always transient — the device went to sleep and
/// the OS suspended the network/process, so the in-flight `wallet.sync()` fails
/// once and then recovers on the next tick after wake. Surfacing a toast for
/// that is pure noise. A sustained outage produces many consecutive failures
/// and still gets reported, just a few backoff cycles later.
const MIN_FAILURES_BEFORE_NOTIFY: u32 = 3;

/// Whether a run of consecutive sync failures warrants a UI toast: the failure
/// streak must be sustained *and* the per-notification cooldown must have
/// elapsed. `since_last_notify` is `None` when no toast has fired yet.
fn should_notify_sync_failure(
    consecutive_failures: u32,
    since_last_notify: Option<Duration>,
) -> bool {
    if consecutive_failures < MIN_FAILURES_BEFORE_NOTIFY {
        return false;
    }
    since_last_notify
        .map(|d| d >= ERROR_NOTIFY_COOLDOWN)
        .unwrap_or(true)
}

/// Spawn a background task that periodically syncs the onchain wallet.
///
/// Returns a `watch::Sender` whose drop signals the task to stop.
///
/// The loop emits `wallet-sync-error` events to the UI, gated by
/// `should_notify_sync_failure` so a lone device-sleep failure stays silent
/// and sustained outages are still throttled to once per `ERROR_NOTIFY_COOLDOWN`.
async fn spawn_onchain_sync(
    wallet: Arc<ark::ArkWallet>,
    app: &tauri::AppHandle,
) -> tokio::sync::watch::Sender<()> {
    use ark_client::wallet::OnchainWallet;

    /// Maximum backoff interval after repeated sync failures.
    const MAX_SYNC_BACKOFF: Duration = Duration::from_secs(600);

    let initial_failures = if let Err(e) = wallet.sync().await {
        warn!("initial onchain sync failed: {e}");
        1
    } else {
        0
    };

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(());
    let bg_wallet = Arc::clone(&wallet);
    let bg_app = app.clone();
    tokio::spawn(async move {
        let mut last_error_notify: Option<tokio::time::Instant> = None;
        let mut consecutive_failures: u32 = initial_failures;

        loop {
            let delay = if consecutive_failures == 0 {
                ONCHAIN_SYNC_INTERVAL
            } else {
                let backoff_secs = ONCHAIN_SYNC_INTERVAL
                    .as_secs()
                    .saturating_mul(1u64 << consecutive_failures.min(10));
                Duration::from_secs(backoff_secs).min(MAX_SYNC_BACKOFF)
            };

            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = cancel_rx.changed() => {
                    debug!("onchain sync task cancelled");
                    break;
                }
            }

            match bg_wallet.sync().await {
                Ok(()) => {
                    consecutive_failures = 0;
                    last_error_notify = None;
                }
                Err(e) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    warn!(
                        consecutive_failures,
                        next_retry_secs = delay.as_secs(),
                        "background onchain sync failed: {e}"
                    );

                    let should_notify = should_notify_sync_failure(
                        consecutive_failures,
                        last_error_notify.map(|t| t.elapsed()),
                    );

                    if should_notify {
                        let _ =
                            bg_app.emit("wallet-sync-error", friendly_sync_error(&e.to_string()));
                        last_error_notify = Some(tokio::time::Instant::now());
                    }
                }
            }
        }
    });
    cancel_tx
}

/// Build and connect an Ark client from an Xpriv and ASP URL.
async fn build_ark_client(
    app: &tauri::AppHandle,
    xpriv: bitcoin::bip32::Xpriv,
    asp_url: &str,
    custom_esplora: Option<&str>,
) -> Result<
    (
        ark::ArkClient,
        Arc<ark::ArkWallet>,
        Arc<ark_client::SqliteSwapStorage>,
        Arc<ark_client::Bip32KeyProvider>,
    ),
    AppError,
> {
    debug!(asp_url = %asp_url, "building Ark client");

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
    let esplora = ark::esplora_url(network, custom_esplora);

    let db_path = boarding_db_path(app)?;
    let store = secure_storage::SecureStorage::get_instance(app).clone();
    let db =
        tokio::task::spawn_blocking(move || ark::FileDb::load(db_path, network, server_pk, store))
            .await
            .map_err(|e| AppError::Wallet(format!("Boarding DB task panicked: {e}")))?
            .map_err(|e| AppError::Wallet(format!("Failed to load boarding DB: {e}")))?;
    let bdk_wallet = ark_bdk_wallet::Wallet::new_from_xpriv(xpriv, secp, network, &esplora, db)
        .map_err(|e| AppError::Wallet(format!("Failed to create BDK wallet: {e}")))?;

    let blockchain = ark::EsploraBlockchain::new(&esplora)
        .map_err(|e| AppError::Wallet(format!("Failed to create blockchain client: {e}")))?;

    let swap_db = swap_db_path(app)?;
    let swap_storage = Arc::new(
        ark_client::SqliteSwapStorage::new(&swap_db)
            .await
            .map_err(|e| AppError::Wallet(format!("Failed to open swap database: {e}")))?,
    );
    let wallet_arc = Arc::new(bdk_wallet);

    // Count existing reverse swaps so the key provider starts at the correct
    // derivation index. Each Lightning swap derives one key, so the swap count
    // is the high-water mark for indices already used.
    let swap_count = {
        use ark_client::SwapStorage;
        swap_storage
            .list_all_reverse()
            .await
            .map(|v| v.len() as u32)
            .unwrap_or(0)
    };

    let derivation_path = std::str::FromStr::from_str(ark_core::DEFAULT_DERIVATION_PATH)
        .expect("valid derivation path");
    let key_provider = Arc::new(ark_client::Bip32KeyProvider::new_with_index(
        xpriv,
        derivation_path,
        swap_count,
    ));

    let offline_client = ark_client::OfflineClient::new(
        "avark".to_string(),
        Arc::clone(&key_provider),
        Arc::new(blockchain),
        Arc::clone(&wallet_arc),
        asp_url.to_string(),
        Arc::clone(&swap_storage),
        BOLTZ_URL.to_string(),
        Duration::from_secs(30),
    );

    let client = offline_client
        .connect()
        .await
        .map_err(|e| AppError::Asp(format!("Failed to connect to ASP: {e}")))?;

    Ok((client, wallet_arc, swap_storage, key_provider))
}

/// Shared setup: read ASP settings, derive keys, build client, persist wallet
/// data, start background sync, and store everything in global state.
async fn finalize_wallet_setup(
    app: &tauri::AppHandle,
    secret: &wallet::SecretMnemonic,
) -> Result<(), AppError> {
    let (asp_url, network, custom_esplora) = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        let settings = read_settings(app).await?;
        let url = settings.asp_url.ok_or_else(|| {
            AppError::Wallet("No ASP URL configured. Connect to an ASP first.".into())
        })?;
        let net_str = settings.network.ok_or_else(|| {
            AppError::Wallet("No network configured. Connect to an ASP first.".into())
        })?;
        let network = net_str
            .parse::<bitcoin::Network>()
            .map_err(|e| AppError::Wallet(format!("Invalid network \"{net_str}\": {e}")))?;
        (url, network, settings.esplora_url)
    };

    let xpriv = wallet::derive_master_xpriv_from_secret(secret, network)
        .map_err(|e| AppError::Wallet(e.to_string()))?;

    let (client, wallet_arc, swap_storage, key_provider) =
        build_ark_client(app, xpriv, &asp_url, custom_esplora.as_deref()).await?;

    let wallet_data = WalletData {
        asp_url,
        network: network.to_string(),
    };
    let path = wallet_path(app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let data = serde_json::to_string_pretty(&wallet_data)?;
    tokio::fs::write(&path, data).await?;

    let store = secure_storage::SecureStorage::get_instance(app);
    if let Err(e) = store_mnemonic(store, secret.words()) {
        // Clean up all artifacts created during this attempt.
        for p in [wallet_path(app), boarding_db_path(app), swap_db_path(app)]
            .into_iter()
            .flatten()
        {
            let _ = tokio::fs::remove_file(&p).await;
        }
        return Err(e);
    }

    let global = app.state::<GlobalWalletState>();
    let sync_cancel = spawn_onchain_sync(Arc::clone(&wallet_arc), app).await;
    let (wallet_cancel, _) = tokio::sync::watch::channel(());
    *global.0.write().await = Some(AppWalletState {
        client: Arc::new(client),
        wallet: wallet_arc,
        swap_storage,
        key_provider,
        _sync_cancel: sync_cancel,
        wallet_cancel,
    });

    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CreateWalletResult {
    mnemonic: String,
}

#[tauri::command]
pub async fn has_wallet(app: tauri::AppHandle) -> Result<bool, AppError> {
    let path = wallet_path(&app)?;
    Ok(tokio::fs::try_exists(&path).await?)
}

#[tauri::command]
pub async fn create_wallet(app: tauri::AppHandle) -> Result<CreateWalletResult, AppError> {
    info!("creating new wallet");

    let creation_lock = app.state::<WalletCreationLock>();
    let _guard = creation_lock.0.lock().await;

    let path = wallet_path(&app)?;
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        warn!("wallet already exists, aborting creation");
        return Err(AppError::Wallet("Wallet already exists".into()));
    }

    let secret = wallet::generate_mnemonic().map_err(|e| AppError::Wallet(e.to_string()))?;
    let mnemonic_words = secret.words().to_owned();

    finalize_wallet_setup(&app, &secret).await?;

    info!("wallet created successfully");
    Ok(CreateWalletResult {
        mnemonic: mnemonic_words,
    })
}

#[tauri::command]
pub async fn restore_wallet(app: tauri::AppHandle, mut mnemonic: String) -> Result<(), AppError> {
    info!("restoring wallet from mnemonic");

    let creation_lock = app.state::<WalletCreationLock>();
    let _guard = creation_lock.0.lock().await;

    use zeroize::Zeroize;

    let path = wallet_path(&app)?;
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        warn!("wallet already exists, aborting restore");
        mnemonic.zeroize();
        return Err(AppError::Wallet("Wallet already exists".into()));
    }

    let secret = wallet::parse_mnemonic(&mnemonic).map_err(|e| {
        mnemonic.zeroize();
        AppError::Wallet(e.to_string())
    })?;
    mnemonic.zeroize();

    finalize_wallet_setup(&app, &secret).await?;

    info!("wallet restored successfully");
    Ok(())
}

#[tauri::command]
pub async fn load_wallet_local(app: tauri::AppHandle) -> Result<(), AppError> {
    info!("validating local wallet state");

    let _wallet_data = read_wallet_data(&app).await?;
    let store = secure_storage::SecureStorage::get_instance(&app);
    let mut words = load_mnemonic(store)?;
    wallet::parse_mnemonic(&words).map_err(|e| AppError::Wallet(e.to_string()))?;
    zeroize::Zeroize::zeroize(&mut words);

    info!("local wallet state is ready");
    Ok(())
}

#[tauri::command]
pub async fn is_wallet_loaded(app: tauri::AppHandle) -> bool {
    let state = app.state::<GlobalWalletState>();
    let loaded = state.0.read().await.is_some();
    loaded
}

#[tauri::command]
pub async fn connect_wallet(app: tauri::AppHandle) -> Result<(), AppError> {
    info!("connecting wallet to ASP");

    let creation_lock = app.state::<WalletCreationLock>();
    let _guard = creation_lock.0.lock().await;

    let global = app.state::<GlobalWalletState>();
    if global.0.read().await.is_some() {
        debug!("Ark client already initialized, skipping connect");
        return Ok(());
    }

    let wallet_data = read_wallet_data(&app).await?;
    let xpriv = derive_wallet_xpriv(&app, &wallet_data)?;
    let custom_esplora = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        read_settings(&app).await.ok().and_then(|s| s.esplora_url)
    };

    let (client, wallet_arc, swap_storage, key_provider) =
        build_ark_client(&app, xpriv, &wallet_data.asp_url, custom_esplora.as_deref()).await?;

    let sync_cancel = spawn_onchain_sync(Arc::clone(&wallet_arc), &app).await;
    let client_arc = Arc::new(client);
    let swap_storage_arc = Arc::clone(&swap_storage);
    let client_for_recovery = Arc::clone(&client_arc);
    let key_provider_for_recovery = Arc::clone(&key_provider);
    let (wallet_cancel, cancel_rx) = tokio::sync::watch::channel(());
    *global.0.write().await = Some(AppWalletState {
        client: client_arc,
        wallet: wallet_arc,
        swap_storage,
        key_provider,
        _sync_cancel: sync_cancel,
        wallet_cancel,
    });

    spawn_pending_swap_recovery(
        client_for_recovery,
        swap_storage_arc,
        key_provider_for_recovery,
        &app,
        cancel_rx,
    );

    info!("wallet connected successfully");
    Ok(())
}

#[tauri::command]
pub async fn delete_wallet(app: tauri::AppHandle) -> Result<(), AppError> {
    warn!("deleting wallet data");

    // 1. Drop in-memory state first — this drops wallet_cancel, signalling all
    //    background tasks (swap recovery, LN claim, onchain sync) to stop.
    let global = app.state::<GlobalWalletState>();
    *global.0.write().await = None;

    // Give background tasks a moment to observe cancellation and release file handles.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 2. Remove wallet.json first — this is what has_wallet() checks, so deleting
    //    it early ensures the app won't see a "wallet exists" state if later steps fail.
    let _ = remove_if_exists(&wallet_path(&app)?).await;

    // 3. Delete mnemonic and Nostr identity from secure storage. WIPE means a
    //    clean slate — leaving the nsec behind would resurrect the previous
    //    npub on re-onboarding.
    let store = secure_storage::SecureStorage::get_instance(&app);
    let _ = store.delete(MNEMONIC_KEY);
    let _ = store.delete(crate::nostr::NSEC_KEY);

    // 4. Best-effort cleanup of remaining files — don't bail on individual failures.
    //    Includes lendaswap.db so a subsequent wallet restore doesn't hit
    //    `MnemonicMismatch` against the SDK's stored mnemonic.
    let _ = remove_if_exists(&boarding_db_path(&app)?).await;
    let _ = remove_if_exists(&swap_db_path(&app)?).await;
    let _ = remove_if_exists(&lendaswap_db_path(&app)?).await;

    // 5. Reset settings.
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await.unwrap_or_default();
    settings.onboarding_seen = false;
    settings.asp_url = None;
    settings.network = None;
    settings.esplora_url = None;
    let _ = write_settings(&app, &settings).await;

    info!("wallet data deleted");
    Ok(())
}

async fn remove_if_exists(path: &std::path::Path) -> Result<(), std::io::Error> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            warn!("failed to remove {}: {e}", path.display());
            Err(e)
        }
    }
}

// ── Wallet data queries ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct WalletBalance {
    onchain_confirmed_sat: u64,
    onchain_pending_sat: u64,
    offchain_confirmed_sat: u64,
    offchain_pre_confirmed_sat: u64,
    offchain_recoverable_sat: u64,
    offchain_total_sat: u64,
    boarding_sat: u64,
}

#[tauri::command]
pub async fn get_balance(app: tauri::AppHandle) -> Result<WalletBalance, AppError> {
    let (client, wallet) = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        (Arc::clone(&ws.client), Arc::clone(&ws.wallet))
    };

    let offchain = client
        .offchain_balance()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to get offchain balance: {e}")))?;

    let onchain = {
        use ark_client::wallet::OnchainWallet;
        wallet
            .balance()
            .map_err(|e| AppError::Wallet(format!("Failed to get onchain balance: {e}")))?
    };

    // Query boarding address UTXOs via Esplora
    let boarding_sat = match query_boarding_balance(&app, &client).await {
        Ok(sat) => sat,
        Err(e) => {
            tracing::warn!("failed to query boarding balance: {e}");
            0
        }
    };

    Ok(WalletBalance {
        onchain_confirmed_sat: onchain.confirmed.to_sat(),
        onchain_pending_sat: onchain.trusted_pending.to_sat() + onchain.untrusted_pending.to_sat(),
        offchain_confirmed_sat: offchain.confirmed().to_sat(),
        offchain_pre_confirmed_sat: offchain.pre_confirmed().to_sat(),
        offchain_recoverable_sat: offchain.recoverable().to_sat(),
        offchain_total_sat: offchain.total().to_sat(),
        boarding_sat,
    })
}

async fn query_boarding_balance(
    app: &tauri::AppHandle,
    client: &crate::ark::ArkClient,
) -> Result<u64, AppError> {
    let boarding_address = client
        .get_boarding_address()
        .map_err(|e| AppError::Wallet(format!("Failed to get boarding address: {e}")))?;

    let wallet_data = read_wallet_data(app).await?;
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network: {e}")))?;
    let custom_esplora = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        read_settings(app).await.ok().and_then(|s| s.esplora_url)
    };
    let esplora_base = crate::ark::esplora_url(network, custom_esplora.as_deref());

    let script_pubkey = boarding_address.script_pubkey();
    let script_hash = bitcoin::hashes::sha256::Hash::hash(script_pubkey.as_bytes());
    let utxo_url = format!("{esplora_base}/scripthash/{script_hash:x}/utxo");

    let http = reqwest::Client::new();
    let utxos: Vec<EsploraUtxo> = http
        .get(&utxo_url)
        .send()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to query boarding UTXOs: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Wallet(format!("Boarding UTXO request failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to parse boarding UTXOs: {e}")))?;

    Ok(utxos.iter().map(|u| u.value).sum())
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum TransactionKind {
    Boarding,
    Commitment,
    Ark,
    Offboard,
}

#[derive(Serialize)]
pub struct TransactionRecord {
    txid: String,
    kind: TransactionKind,
    amount_sat: i64,
    created_at: Option<i64>,
    is_settled: Option<bool>,
}

#[tauri::command]
pub async fn get_transactions(app: tauri::AppHandle) -> Result<Vec<TransactionRecord>, AppError> {
    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        Arc::clone(
            &guard
                .as_ref()
                .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?
                .client,
        )
    };

    let history = client
        .transaction_history()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to get transaction history: {e}")))?;

    let records: Vec<TransactionRecord> = history
        .into_iter()
        .map(|tx| match tx {
            ark_core::history::Transaction::Boarding {
                txid,
                amount,
                confirmed_at,
            } => TransactionRecord {
                txid: txid.to_string(),
                kind: TransactionKind::Boarding,
                amount_sat: i64::try_from(amount.to_sat()).unwrap_or(i64::MAX),
                created_at: confirmed_at,
                is_settled: None,
            },
            ark_core::history::Transaction::Commitment {
                txid,
                amount,
                created_at,
            } => TransactionRecord {
                txid: txid.to_string(),
                kind: TransactionKind::Commitment,
                amount_sat: amount.to_sat(),
                created_at: Some(created_at),
                is_settled: None,
            },
            ark_core::history::Transaction::Ark {
                txid,
                amount,
                is_settled,
                created_at,
            } => TransactionRecord {
                txid: txid.to_string(),
                kind: TransactionKind::Ark,
                amount_sat: amount.to_sat(),
                created_at: Some(created_at),
                is_settled: Some(is_settled),
            },
            ark_core::history::Transaction::Offboard {
                commitment_txid,
                amount,
                confirmed_at,
            } => TransactionRecord {
                txid: commitment_txid.to_string(),
                kind: TransactionKind::Offboard,
                amount_sat: -i64::try_from(amount.to_sat()).unwrap_or(i64::MAX),
                created_at: confirmed_at,
                is_settled: None,
            },
        })
        .collect();

    Ok(records)
}

#[tauri::command]
pub async fn get_mnemonic(app: tauri::AppHandle) -> Result<String, AppError> {
    warn!("mnemonic requested — ensure this is only exposed in the backup/export flow");
    let store = secure_storage::SecureStorage::get_instance(&app);
    load_mnemonic(store)
}

#[tauri::command]
pub async fn verify_mnemonic(app: tauri::AppHandle, mnemonic: String) -> Result<bool, AppError> {
    use subtle::ConstantTimeEq;

    let store = secure_storage::SecureStorage::get_instance(&app);
    let stored = load_mnemonic(store)?;

    let input_normalized: String = mnemonic.split_whitespace().collect::<Vec<_>>().join(" ");
    let stored_normalized: String = stored.split_whitespace().collect::<Vec<_>>().join(" ");

    let input_bytes = input_normalized.as_bytes();
    let stored_bytes = stored_normalized.as_bytes();

    if input_bytes.len() != stored_bytes.len() {
        return Ok(false);
    }

    let valid: bool = input_bytes.ct_eq(stored_bytes).into();

    if valid {
        warn!("wallet unlocked via seed-phrase recovery");
        let _ = app.emit(
            "security-event",
            super::pin::SecurityEvent {
                kind: "seed-recovery",
                detail: "Wallet unlocked via seed phrase",
            },
        );
    } else {
        warn!("seed-phrase recovery attempted — mismatch");
    }

    Ok(valid)
}

/// Minimal representation of Esplora's `/scripthash/:hash/utxo` response items.
#[derive(Deserialize)]
struct EsploraUtxo {
    txid: bitcoin::Txid,
    vout: u32,
    value: u64,
}

#[derive(Serialize)]
pub struct SettleResult {
    settled: bool,
    txid: Option<String>,
}

#[tauri::command]
pub async fn settle(app: tauri::AppHandle) -> Result<SettleResult, AppError> {
    info!("settling boarding UTXOs into next round");

    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        Arc::clone(&ws.client)
    };

    // Discover boarding UTXOs on-chain.
    let boarding_address = client
        .get_boarding_address()
        .map_err(|e| AppError::Wallet(format!("Failed to get boarding address: {e}")))?;

    let wallet_data = read_wallet_data(&app).await?;
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network: {e}")))?;
    let custom_esplora = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        read_settings(&app).await.ok().and_then(|s| s.esplora_url)
    };
    let esplora_base = ark::esplora_url(network, custom_esplora.as_deref());

    let script_pubkey = boarding_address.script_pubkey();

    // Single request to get unspent UTXOs for the boarding address.
    let script_hash = bitcoin::hashes::sha256::Hash::hash(script_pubkey.as_bytes());
    let utxo_url = format!("{esplora_base}/scripthash/{script_hash:x}/utxo");
    let http = reqwest::Client::new();
    let boarding_outpoints: Vec<bitcoin::OutPoint> = http
        .get(&utxo_url)
        .send()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to query boarding UTXOs: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Wallet(format!("Boarding UTXO request failed: {e}")))?
        .json::<Vec<EsploraUtxo>>()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to parse boarding UTXOs: {e}")))?
        .into_iter()
        .map(|u| {
            let outpoint = bitcoin::OutPoint {
                txid: u.txid,
                vout: u.vout,
            };
            info!(outpoint = %outpoint, "found unspent boarding UTXO");
            outpoint
        })
        .collect();

    if boarding_outpoints.is_empty() {
        info!("no unspent boarding UTXOs found");
        return Ok(SettleResult {
            settled: false,
            txid: None,
        });
    }

    info!(count = boarding_outpoints.len(), "settling boarding UTXOs");

    use rand::SeedableRng;
    let mut rng = rand::rngs::StdRng::from_entropy();
    let result = client
        .settle_vtxos(&mut rng, &[], &boarding_outpoints)
        .await
        .map_err(|e| AppError::Wallet(format!("Settlement failed: {e}")))?;

    match result {
        Some(txid) => {
            info!(txid = %txid, "settlement completed");
            Ok(SettleResult {
                settled: true,
                txid: Some(txid.to_string()),
            })
        }
        None => {
            info!("nothing to settle");
            Ok(SettleResult {
                settled: false,
                txid: None,
            })
        }
    }
}

#[derive(Serialize)]
pub struct RoundSchedule {
    /// Unix timestamp (seconds) of the next round start. Only populated when
    /// the ASP publishes a `scheduled_session`; otherwise `None` and the UI
    /// falls back to showing `session_duration` as a static cadence.
    next_start_time: Option<i64>,
    /// How long a round stays open, in seconds. Always populated from the
    /// ASP's `Info.session_duration`.
    session_duration: u64,
}

/// Return the ASP's round schedule so the UI can show a countdown when
/// possible, or at least a static cadence.
#[tauri::command]
pub async fn get_round_schedule(app: tauri::AppHandle) -> Result<RoundSchedule, AppError> {
    let asp_url = read_wallet_data(&app).await?.asp_url;
    let mut grpc = ark_grpc::Client::new(asp_url);
    // Single timeout covers connect + get_info so the UI call can't exceed 10s
    let info = tokio::time::timeout(Duration::from_secs(10), async {
        grpc.connect()
            .await
            .map_err(|e| AppError::Asp(format!("Connection failed: {e}")))?;
        grpc.get_info()
            .await
            .map_err(|e| AppError::Asp(format!("Failed to get server info: {e}")))
    })
    .await
    .map_err(|_| AppError::Asp("Server info request timed out".into()))??;

    Ok(RoundSchedule {
        next_start_time: info.scheduled_session.map(|s| s.next_start_time),
        session_duration: info.session_duration,
    })
}

#[derive(Serialize)]
pub struct ReceiveAddresses {
    ark_address: String,
    boarding_address: String,
}

#[tauri::command]
pub async fn get_receive_address(app: tauri::AppHandle) -> Result<ReceiveAddresses, AppError> {
    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        Arc::clone(
            &guard
                .as_ref()
                .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?
                .client,
        )
    };

    let (ark_addr, _vtxo) = client
        .get_offchain_address()
        .map_err(|e| AppError::Wallet(format!("Failed to get offchain address: {e}")))?;

    let boarding_addr = client
        .get_boarding_address()
        .map_err(|e| AppError::Wallet(format!("Failed to get boarding address: {e}")))?;

    Ok(ReceiveAddresses {
        ark_address: ark_addr.encode(),
        boarding_address: boarding_addr.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_sync_error_classifies_rate_limit() {
        assert!(friendly_sync_error("HTTP 429 Too Many Requests").contains("rate limited"));
    }

    #[test]
    fn friendly_sync_error_classifies_timeout() {
        assert!(friendly_sync_error("operation timed out").contains("timed out"));
    }

    #[test]
    fn friendly_sync_error_classifies_incomplete_message_as_network_error() {
        // The dominant failure on hostile mobile networks — it must not fall
        // through to the generic message.
        let raw = "Reqwest(reqwest::Error { kind: Request, \
                   source: hyper::Error(IncompleteMessage) })";
        assert!(friendly_sync_error(raw).contains("network error"));
    }

    #[test]
    fn friendly_sync_error_classifies_connection_reset_as_network_error() {
        let raw = "Os { code: 104, kind: ConnectionReset, message: \"Connection reset by peer\" }";
        assert!(friendly_sync_error(raw).contains("network error"));
    }

    #[test]
    fn friendly_sync_error_classifies_dns_failure_as_network_error() {
        let raw = "ConnectError(\"dns error\", \"failed to lookup address information\")";
        assert!(friendly_sync_error(raw).contains("network error"));
    }

    #[test]
    fn friendly_sync_error_classifies_tls_abort_as_network_error() {
        assert!(
            friendly_sync_error("Connect, Ssl(Error { code: ErrorCode(5) })")
                .contains("network error")
        );
    }

    #[test]
    fn friendly_sync_error_falls_through_to_generic() {
        let msg = friendly_sync_error("something totally unexpected");
        assert!(msg.contains("will retry automatically"));
        assert!(!msg.contains("network error"));
    }

    #[test]
    fn lone_sync_failure_stays_silent() {
        // A single failure is the device-sleep case — no toast.
        assert!(!should_notify_sync_failure(1, None));
        assert!(!should_notify_sync_failure(2, None));
    }

    #[test]
    fn sustained_sync_failure_notifies_once_threshold_met() {
        // First time the streak reaches the threshold, with no prior toast.
        assert!(should_notify_sync_failure(MIN_FAILURES_BEFORE_NOTIFY, None));
        assert!(should_notify_sync_failure(10, None));
    }

    #[test]
    fn sync_failure_notify_respects_cooldown() {
        // Streak is sustained, but a toast fired recently — stay quiet.
        assert!(!should_notify_sync_failure(
            10,
            Some(ERROR_NOTIFY_COOLDOWN - Duration::from_secs(1))
        ));
        // Cooldown elapsed — notify again.
        assert!(should_notify_sync_failure(10, Some(ERROR_NOTIFY_COOLDOWN)));
        assert!(should_notify_sync_failure(
            10,
            Some(ERROR_NOTIFY_COOLDOWN + Duration::from_secs(60))
        ));
    }

    #[test]
    fn cooldown_does_not_rescue_a_sub_threshold_streak() {
        // Even with the cooldown long elapsed, a short streak never notifies.
        assert!(!should_notify_sync_failure(
            1,
            Some(ERROR_NOTIFY_COOLDOWN * 10)
        ));
    }
}
