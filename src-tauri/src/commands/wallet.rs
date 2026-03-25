use bitcoin::hashes::Hash as _;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tracing::{debug, info, warn};

use super::lightning::{spawn_pending_swap_recovery, BOLTZ_URL};
use crate::{
    ark, boarding_db_path, load_mnemonic, read_settings, secure_storage, store_mnemonic,
    swap_db_path, wallet, wallet_path, write_settings, AppError, AppWalletState, GlobalWalletState,
    SettingsLock, WalletCreationLock, MNEMONIC_KEY, ONCHAIN_SYNC_INTERVAL,
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

/// Spawn a background task that periodically syncs the onchain wallet.
///
/// Returns a `watch::Sender` whose drop signals the task to stop.
///
/// The loop emits `wallet-sync-error` events to the UI, throttled to at most
/// once per `ERROR_NOTIFY_COOLDOWN` of consecutive failures so the user stays
/// informed without being spammed.
async fn spawn_onchain_sync(
    wallet: Arc<ark::ArkWallet>,
    app: &tauri::AppHandle,
) -> tokio::sync::watch::Sender<()> {
    use ark_client::wallet::OnchainWallet;

    /// Minimum interval between UI error notifications for consecutive sync failures.
    const ERROR_NOTIFY_COOLDOWN: Duration = Duration::from_secs(5 * 60);

    if let Err(e) = wallet.sync().await {
        warn!("initial onchain sync failed: {e}");
        let _ = app.emit("wallet-sync-error", format!("Onchain sync failed: {e}"));
    }

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(());
    let bg_wallet = Arc::clone(&wallet);
    let bg_app = app.clone();
    tokio::spawn(async move {
        let mut last_error_notify: Option<tokio::time::Instant> = None;

        loop {
            tokio::select! {
                _ = tokio::time::sleep(ONCHAIN_SYNC_INTERVAL) => {}
                _ = cancel_rx.changed() => {
                    debug!("onchain sync task cancelled");
                    break;
                }
            }

            match bg_wallet.sync().await {
                Ok(()) => {
                    // Reset throttle on success so the next failure notifies immediately.
                    last_error_notify = None;
                }
                Err(e) => {
                    warn!("background onchain sync failed: {e}");

                    let should_notify = last_error_notify
                        .map(|t| t.elapsed() >= ERROR_NOTIFY_COOLDOWN)
                        .unwrap_or(true);

                    if should_notify {
                        let _ =
                            bg_app.emit("wallet-sync-error", format!("Onchain sync failed: {e}"));
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
    let esplora = ark::esplora_url(network);

    let db_path = boarding_db_path(app)?;
    let store = secure_storage::SecureStorage::get_instance(app).clone();
    let db =
        tokio::task::spawn_blocking(move || ark::FileDb::load(db_path, network, server_pk, store))
            .await
            .map_err(|e| AppError::Wallet(format!("Boarding DB task panicked: {e}")))?
            .map_err(|e| AppError::Wallet(format!("Failed to load boarding DB: {e}")))?;
    let bdk_wallet = ark_bdk_wallet::Wallet::new_from_xpriv(xpriv, secp, network, esplora, db)
        .map_err(|e| AppError::Wallet(format!("Failed to create BDK wallet: {e}")))?;

    let blockchain = ark::EsploraBlockchain::new(esplora)
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
    let (asp_url, network) = {
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
        (url, network)
    };

    let xpriv = wallet::derive_master_xpriv_from_secret(secret, network)
        .map_err(|e| AppError::Wallet(e.to_string()))?;

    let (client, wallet_arc, swap_storage, key_provider) =
        build_ark_client(app, xpriv, &asp_url).await?;

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
        for artifact in [wallet_path(app), boarding_db_path(app), swap_db_path(app)] {
            if let Ok(p) = artifact {
                let _ = tokio::fs::remove_file(&p).await;
            }
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

    let (client, wallet_arc, swap_storage, key_provider) =
        build_ark_client(&app, xpriv, &wallet_data.asp_url).await?;

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

    // 3. Delete mnemonic from secure storage.
    let store = secure_storage::SecureStorage::get_instance(&app);
    let _ = store.delete(MNEMONIC_KEY);

    // 4. Best-effort cleanup of remaining files — don't bail on individual failures.
    let _ = remove_if_exists(&boarding_db_path(&app)?).await;
    let _ = remove_if_exists(&swap_db_path(&app)?).await;

    // 5. Reset settings.
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await.unwrap_or_default();
    settings.onboarding_seen = false;
    settings.asp_url = None;
    settings.network = None;
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

    Ok(WalletBalance {
        onchain_confirmed_sat: onchain.confirmed.to_sat(),
        onchain_pending_sat: onchain.trusted_pending.to_sat() + onchain.untrusted_pending.to_sat(),
        offchain_confirmed_sat: offchain.confirmed().to_sat(),
        offchain_pre_confirmed_sat: offchain.pre_confirmed().to_sat(),
        offchain_recoverable_sat: offchain.recoverable().to_sat(),
        offchain_total_sat: offchain.total().to_sat(),
    })
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

/// Minimal representation of Esplora's `/scripthash/:hash/utxo` response items.
#[derive(Deserialize)]
struct EsploraUtxo {
    txid: bitcoin::Txid,
    vout: u32,
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
    let esplora_base = ark::esplora_url(network);

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
