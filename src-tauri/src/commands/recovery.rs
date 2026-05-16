use bitcoin::consensus::encode;
use bitcoin::{Transaction, Txid};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::time::Instant;
use tracing::{debug, info, warn};

use crate::{
    ark, boarding_db_path, load_mnemonic, secure_storage, unilateral_exit_cache_path, wallet,
    AppError, GlobalWalletState, SettingsLock,
};

const CACHE_VERSION: u32 = 1;
const LIST_VTXOS_TIMEOUT: Duration = Duration::from_secs(30);
// A single `get_vtxo_chain` / `get_virtual_txs` call for a real mainnet VTXO
// returns hundreds of KB and takes ~30s server-side — see the chain depth on
// arbitrary mainnet VTXOs. The per-request and total budgets must be generous
// enough to actually complete, or every VTXO times out and nothing is cached.
const VTXO_REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const REFRESH_TIME_BUDGET: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize, Deserialize)]
struct CachedExitTx {
    txid: String,
    tx_hex: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct UnilateralExitCache {
    version: u32,
    generated_at: i64,
    asp_digest: String,
    network: String,
    /// Hex-encoded x-only public key of the ASP signer. Required for the offline
    /// broadcast context to reconstruct the BDK wallet without the ASP. Optional
    /// for backward-compatibility with packages cached before this field existed
    /// — those need to be refreshed once before offline broadcast can run.
    #[serde(default)]
    server_pk: Option<String>,
    branch_count: usize,
    tx_count: usize,
    failed_outpoints: Vec<String>,
    branches: Vec<Vec<CachedExitTx>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnilateralExitCacheStatus {
    exists: bool,
    generated_at: Option<i64>,
    network: Option<String>,
    branch_count: usize,
    tx_count: usize,
    failed_count: usize,
    last_error: Option<String>,
}

struct BestEffortExitTrees {
    branches: Vec<Vec<Transaction>>,
    failed_outpoints: Vec<String>,
    last_error: Option<String>,
}

fn now_unix() -> Result<i64, AppError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Wallet(format!("System clock error: {e}")))?;
    Ok(duration.as_secs() as i64)
}

fn cache_status(
    cache: &UnilateralExitCache,
    last_error: Option<String>,
) -> UnilateralExitCacheStatus {
    UnilateralExitCacheStatus {
        exists: true,
        generated_at: Some(cache.generated_at),
        network: Some(cache.network.clone()),
        branch_count: cache.branch_count,
        tx_count: cache.tx_count,
        failed_count: cache.failed_outpoints.len(),
        last_error,
    }
}

async fn read_cache(app: &tauri::AppHandle) -> Result<Option<UnilateralExitCache>, AppError> {
    let path = unilateral_exit_cache_path(app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e)),
    }
}

fn remaining_timeout(deadline: Instant, label: &str) -> Result<Duration, AppError> {
    let now = Instant::now();
    if now >= deadline {
        return Err(AppError::Wallet(format!(
            "Recovery package refresh timed out while {label}"
        )));
    }
    Ok(VTXO_REQUEST_TIMEOUT.min(deadline - now))
}

/// Build the dependency-ordered list of virtual transactions that must be
/// broadcast to unilaterally exit the VTXO at `vtxo_txid`, plus the commitment
/// transactions its chain roots in.
///
/// Walks the ancestor sub-DAG once and emits each transaction only after all of
/// its parents — a topological sort, `O(nodes)`. The SDK's
/// `build_unilateral_exit_tree_txids` instead enumerates every distinct
/// root-to-leaf *path*, which is exponential on branchy mainnet chains: a real
/// VTXO produced ~530k paths and exhausted device memory.
///
/// Commitment transactions are already confirmed on-chain, so they terminate
/// the walk and are returned separately rather than placed in the broadcast
/// order.
fn build_exit_broadcast_order(
    chains: &ark_core::server::VtxoChains,
    vtxo_txid: Txid,
) -> Result<(Vec<Txid>, Vec<Txid>), AppError> {
    use ark_core::server::{ChainedTxType, VtxoChain};

    let chain_map: HashMap<Txid, &VtxoChain> = chains.inner.iter().map(|c| (c.txid, c)).collect();

    #[derive(PartialEq)]
    enum Mark {
        InProgress,
        Done,
    }

    let mut marks: HashMap<Txid, Mark> = HashMap::new();
    let mut order: Vec<Txid> = Vec::new();
    let mut commitments: Vec<Txid> = Vec::new();
    // Each frame: (txid, index of the next parent in `spends` to descend into).
    let mut stack: Vec<(Txid, usize)> = vec![(vtxo_txid, 0)];

    while let Some(&(txid, parent_idx)) = stack.last() {
        let chain = chain_map
            .get(&txid)
            .ok_or_else(|| AppError::Wallet(format!("VTXO chain is missing transaction {txid}")))?;

        if parent_idx == 0 {
            match marks.get(&txid) {
                Some(Mark::Done) => {
                    stack.pop();
                    continue;
                }
                Some(Mark::InProgress) => {
                    return Err(AppError::Wallet(format!(
                        "VTXO chain contains a cycle at {txid}"
                    )));
                }
                None => {
                    marks.insert(txid, Mark::InProgress);
                }
            }
        }

        // Commitment transactions are already on-chain — they terminate the
        // walk and are never broadcast.
        if matches!(chain.tx_type, ChainedTxType::Commitment) {
            marks.insert(txid, Mark::Done);
            commitments.push(txid);
            stack.pop();
            continue;
        }

        // A non-commitment transaction with no parents can never connect back
        // to an on-chain commitment — the chain the ASP returned is broken.
        if chain.spends.is_empty() {
            return Err(AppError::Wallet(format!(
                "VTXO chain dead-ends at {txid} with no commitment ancestor"
            )));
        }

        if parent_idx < chain.spends.len() {
            stack.last_mut().expect("stack is non-empty").1 = parent_idx + 1;
            let parent = chain.spends[parent_idx];
            if marks.get(&parent) != Some(&Mark::Done) {
                stack.push((parent, 0));
            }
            continue;
        }

        // Every parent has been emitted — this transaction follows them.
        marks.insert(txid, Mark::Done);
        order.push(txid);
        stack.pop();
    }

    if order.is_empty() {
        return Err(AppError::Wallet(format!(
            "no exit transactions found for VTXO {vtxo_txid}"
        )));
    }

    Ok((order, commitments))
}

async fn build_exit_trees_best_effort(
    app: &tauri::AppHandle,
    client: &ark::ArkClient,
) -> Result<BestEffortExitTrees, AppError> {
    use ark_client::Blockchain;
    use ark_core::unilateral_exit::{sign_unilateral_exit_tree, UnilateralExitTree};

    let deadline = Instant::now() + REFRESH_TIME_BUDGET;
    let (vtxo_list, _) = tokio::time::timeout(LIST_VTXOS_TIMEOUT, client.list_vtxos())
        .await
        .map_err(|_| AppError::Asp("Timed out listing VTXOs".into()))?
        .map_err(|e| AppError::Wallet(format!("Failed to list VTXOs: {e}")))?;

    let wallet_data = super::wallet::read_wallet_data(app).await?;
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network: {e}")))?;
    let custom_esplora = {
        let state = app.state::<crate::SettingsLock>();
        let _lock = state.0.read().await;
        crate::read_settings(app)
            .await
            .ok()
            .and_then(|s| s.esplora_url)
    };
    let esplora =
        ark::EsploraBlockchain::new(&ark::esplora_url(network, custom_esplora.as_deref()))
            .map_err(|e| AppError::Wallet(format!("Failed to create explorer client: {e}")))?;

    let mut branches = Vec::new();
    let mut failed_outpoints = Vec::new();
    let mut last_error = None;
    let exit_candidates = vtxo_list
        .could_exit_unilaterally()
        .cloned()
        .collect::<Vec<_>>();

    for (index, virtual_tx_outpoint) in exit_candidates.iter().enumerate() {
        if Instant::now() >= deadline {
            let message = "Recovery package refresh time budget reached".to_string();
            for skipped in &exit_candidates[index..] {
                failed_outpoints.push(skipped.outpoint.to_string());
            }
            last_error = Some(message);
            break;
        }

        let outpoint = virtual_tx_outpoint.outpoint;
        let branch_result: Result<Vec<Vec<Transaction>>, AppError> = async {
            let vtxo_chain_response = tokio::time::timeout(
                remaining_timeout(deadline, "fetching VTXO chain")?,
                client.network_client().get_vtxo_chain(Some(outpoint), None),
            )
            .await
            .map_err(|_| AppError::Asp(format!("Timed out fetching VTXO chain for {outpoint}")))?
            .map_err(|e| {
                AppError::Asp(format!("Failed to fetch VTXO chain for {outpoint}: {e}"))
            })?;

            let (broadcast_order, commitment_txids) =
                build_exit_broadcast_order(&vtxo_chain_response.chains, outpoint.txid)?;

            let virtual_txs_response = tokio::time::timeout(
                remaining_timeout(deadline, "fetching virtual transactions")?,
                client.network_client().get_virtual_txs(
                    broadcast_order.iter().map(ToString::to_string).collect(),
                    None,
                ),
            )
            .await
            .map_err(|_| AppError::Asp(format!("Timed out fetching virtual TXs for {outpoint}")))?
            .map_err(|e| {
                AppError::Asp(format!("Failed to fetch virtual TXs for {outpoint}: {e}"))
            })?;

            // Index the fetched PSBTs by txid so the branch assembles in O(n).
            // The previous implementation rescanned the whole response — and
            // recomputed every txid — once per transaction in the tree.
            let mut psbt_by_txid: HashMap<Txid, _> = virtual_txs_response
                .txs
                .into_iter()
                .map(|tx| (tx.unsigned_tx.compute_txid(), tx))
                .collect();

            let ordered_psbts = broadcast_order
                .iter()
                .map(|txid| {
                    psbt_by_txid.remove(txid).ok_or_else(|| {
                        AppError::Wallet(format!("No virtual transaction found for {txid}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;

            // One dependency-ordered branch per VTXO. `sign_unilateral_exit_tree`
            // resolves each transaction's witness UTXO against the rest of the
            // branch, and the topological order guarantees every parent is present.
            let exit_tree = UnilateralExitTree::new(commitment_txids.clone(), vec![ordered_psbts]);

            let mut commitment_txs = Vec::with_capacity(commitment_txids.len());
            for commitment_txid in &commitment_txids {
                let commitment_tx = tokio::time::timeout(
                    remaining_timeout(deadline, "fetching commitment transaction")?,
                    esplora.find_tx(commitment_txid),
                )
                .await
                .map_err(|_| {
                    AppError::Wallet(format!(
                        "Timed out fetching commitment TX {commitment_txid}"
                    ))
                })?
                .map_err(|e| {
                    AppError::Wallet(format!(
                        "Failed to fetch commitment TX {commitment_txid}: {e}"
                    ))
                })?
                .ok_or_else(|| {
                    AppError::Wallet(format!("Could not find commitment TX {commitment_txid}"))
                })?;

                commitment_txs.push(commitment_tx);
            }

            sign_unilateral_exit_tree(&exit_tree, &commitment_txs).map_err(|e| {
                AppError::Wallet(format!("Failed to sign exit tree for {outpoint}: {e}"))
            })
        }
        .await;

        match branch_result {
            Ok(mut vtxo_branches) => branches.append(&mut vtxo_branches),
            Err(e) => {
                let message = e.to_string();
                warn!(outpoint = %outpoint, error = %message, "skipping VTXO in recovery cache refresh");
                failed_outpoints.push(outpoint.to_string());
                last_error = Some(message);
            }
        }
    }

    Ok(BestEffortExitTrees {
        branches,
        failed_outpoints,
        last_error,
    })
}

pub(crate) async fn refresh_unilateral_exit_cache_for_client(
    app: &tauri::AppHandle,
    client: Arc<ark::ArkClient>,
) -> Result<UnilateralExitCacheStatus, AppError> {
    info!("refreshing unilateral exit recovery cache");

    let result = build_exit_trees_best_effort(app, &client).await?;

    if result.branches.is_empty() && !result.failed_outpoints.is_empty() {
        return Ok(UnilateralExitCacheStatus {
            exists: false,
            generated_at: None,
            network: Some(client.server_info.network.to_string()),
            branch_count: 0,
            tx_count: 0,
            failed_count: result.failed_outpoints.len(),
            last_error: result.last_error,
        });
    }

    let tx_count = result.branches.iter().map(Vec::len).sum();
    let cached_branches = result
        .branches
        .into_iter()
        .map(|branch| {
            branch
                .into_iter()
                .map(|tx| CachedExitTx {
                    txid: tx.compute_txid().to_string(),
                    tx_hex: encode::serialize_hex(&tx),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let last_error = result.last_error;
    let (server_pk, _parity) = client.server_info.signer_pk.x_only_public_key();
    let cache = UnilateralExitCache {
        version: CACHE_VERSION,
        generated_at: now_unix()?,
        asp_digest: client.server_info.digest.clone(),
        network: client.server_info.network.to_string(),
        server_pk: Some(server_pk.to_string()),
        branch_count: cached_branches.len(),
        tx_count,
        failed_outpoints: result.failed_outpoints,
        branches: cached_branches,
    };

    let path = unilateral_exit_cache_path(app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }

    let data = serde_json::to_string_pretty(&cache)?;
    let tmp_path = path.with_extension("json.tmp");
    tokio::fs::write(&tmp_path, data).await?;
    tokio::fs::rename(&tmp_path, &path).await?;

    info!(
        branch_count = cache.branch_count,
        tx_count = cache.tx_count,
        "unilateral exit recovery cache refreshed"
    );

    Ok(cache_status(&cache, last_error))
}

pub(crate) fn spawn_unilateral_exit_cache_refresh(
    app: tauri::AppHandle,
    client: Arc<ark::ArkClient>,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = refresh_unilateral_exit_cache_for_client(&app, client).await {
            warn!("failed to refresh unilateral exit recovery cache: {e}");
        }
    });
}

#[tauri::command]
pub async fn refresh_unilateral_exit_cache(
    app: tauri::AppHandle,
) -> Result<UnilateralExitCacheStatus, AppError> {
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

    refresh_unilateral_exit_cache_for_client(&app, client).await
}

#[tauri::command]
pub async fn get_unilateral_exit_cache_status(
    app: tauri::AppHandle,
) -> Result<UnilateralExitCacheStatus, AppError> {
    match read_cache(&app).await? {
        Some(cache) => {
            debug!(
                branch_count = cache.branch_count,
                tx_count = cache.tx_count,
                "loaded unilateral exit recovery cache status"
            );
            Ok(cache_status(&cache, None))
        }
        None => Ok(UnilateralExitCacheStatus {
            exists: false,
            generated_at: None,
            network: None,
            branch_count: 0,
            tx_count: 0,
            failed_count: 0,
            last_error: None,
        }),
    }
}

// ── Offline broadcast ───────────────────────────────────────────────────
//
// Everything below runs without the ASP. The broadcast context is built from
// disk (mnemonic in secure storage, network in `wallet.json`, server_pk in
// the recovery cache) so the user can publish the cached exit tree even when
// `connect_wallet` has failed.

/// Minimal wallet pieces needed to fee-bump and broadcast the cached exit
/// tree without contacting the ASP. None of these talk to the ASP — by design
/// the broadcast path is ASP-free whether or not we're currently connected.
pub(crate) struct OfflineBroadcastCtx {
    pub(crate) blockchain: ark::EsploraBlockchain,
    pub(crate) wallet: Arc<ark::ArkWallet>,
    pub(crate) timeout: Duration,
}

const OFFLINE_BROADCAST_TIMEOUT: Duration = Duration::from_secs(30);

/// Best-effort wallet sync with exponential backoff. Mobile networks hostile
/// to esplora (TLS resets, incomplete-message) drop a single sync attempt
/// regularly; retrying a couple of times turns most transient outages into a
/// successful sync within a few seconds.
async fn sync_wallet_with_retry(wallet: &ark::ArkWallet) -> Result<(), String> {
    use ark_client::wallet::OnchainWallet;

    const MAX_ATTEMPTS: u32 = 3;
    const BASE_DELAY: Duration = Duration::from_millis(300);

    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match wallet.sync().await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_error = e.to_string();
                if attempt < MAX_ATTEMPTS {
                    let delay = BASE_DELAY * 2u32.pow(attempt - 1);
                    debug!(attempt, "wallet sync failed; retrying after {delay:?}");
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_error)
}

/// Build the broadcast context. When a connected wallet exists in
/// `GlobalWalletState`, reuse its BDK wallet — it's already been syncing in the
/// background, so it reflects current onchain state without depending on a
/// fresh sync succeeding right now. Constructing a brand-new BDK wallet on every
/// preflight call would discard that cached state and put us at the mercy of a
/// single esplora request on a flaky network. Fall back to the from-disk path
/// only when truly offline.
async fn build_offline_broadcast_ctx(
    app: &tauri::AppHandle,
) -> Result<OfflineBroadcastCtx, AppError> {
    let connected_wallet = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        guard.as_ref().map(|ws| Arc::clone(&ws.wallet))
    };

    if let Some(wallet) = connected_wallet {
        let wallet_data = super::wallet::read_wallet_data(app).await?;
        let network = wallet_data
            .network
            .parse::<bitcoin::Network>()
            .map_err(|e| AppError::Wallet(format!("Invalid network in wallet.json: {e}")))?;
        let custom_esplora = {
            let state = app.state::<SettingsLock>();
            let _lock = state.0.read().await;
            crate::read_settings(app)
                .await
                .ok()
                .and_then(|s| s.esplora_url)
        };
        let esplora_url = ark::esplora_url(network, custom_esplora.as_deref());
        let blockchain = ark::EsploraBlockchain::new(&esplora_url)
            .map_err(|e| AppError::Wallet(format!("Failed to create esplora client: {e}")))?;

        return Ok(OfflineBroadcastCtx {
            blockchain,
            wallet,
            timeout: OFFLINE_BROADCAST_TIMEOUT,
        });
    }

    build_from_disk_broadcast_ctx(app).await
}

/// True-offline path: rebuild the BDK wallet from disk without any live
/// connected state. Used when `GlobalWalletState` is empty — i.e. the ASP
/// connection failed and the user is in the offline-mode UI.
async fn build_from_disk_broadcast_ctx(
    app: &tauri::AppHandle,
) -> Result<OfflineBroadcastCtx, AppError> {
    let cache = read_cache(app).await?.ok_or_else(|| {
        AppError::Wallet("No recovery package cached. Refresh while connected first.".into())
    })?;

    let server_pk_hex = cache.server_pk.as_deref().ok_or_else(|| {
        AppError::Wallet(
            "Recovery package was cached before offline broadcast was supported. \
             Refresh while connected to enable."
                .into(),
        )
    })?;
    let server_pk: bitcoin::XOnlyPublicKey = server_pk_hex
        .parse()
        .map_err(|e| AppError::Wallet(format!("Invalid server_pk in cache: {e}")))?;

    let wallet_data = super::wallet::read_wallet_data(app).await?;
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network in wallet.json: {e}")))?;

    if wallet_data.network != cache.network {
        return Err(AppError::Wallet(format!(
            "Network mismatch: recovery package is for {}, wallet is on {}",
            cache.network, wallet_data.network
        )));
    }

    let store = secure_storage::SecureStorage::get_instance(app);
    let mnemonic_words = load_mnemonic(store)?;
    let xpriv = wallet::derive_master_xpriv(&mnemonic_words, network)
        .map_err(|e| AppError::Wallet(e.to_string()))?;

    let custom_esplora = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        crate::read_settings(app)
            .await
            .ok()
            .and_then(|s| s.esplora_url)
    };
    let esplora_url = ark::esplora_url(network, custom_esplora.as_deref());

    let blockchain = ark::EsploraBlockchain::new(&esplora_url)
        .map_err(|e| AppError::Wallet(format!("Failed to create esplora client: {e}")))?;

    let secp = bitcoin::key::Secp256k1::new();
    let db_path = boarding_db_path(app)?;
    let store_for_db = secure_storage::SecureStorage::get_instance(app).clone();
    let db = tokio::task::spawn_blocking(move || {
        ark::FileDb::load(db_path, network, server_pk, store_for_db)
    })
    .await
    .map_err(|e| AppError::Wallet(format!("Boarding DB task panicked: {e}")))?
    .map_err(|e| AppError::Wallet(format!("Failed to load boarding DB: {e}")))?;

    let bdk_wallet = ark_bdk_wallet::Wallet::new_from_xpriv(xpriv, secp, network, &esplora_url, db)
        .map_err(|e| AppError::Wallet(format!("Failed to create BDK wallet: {e}")))?;

    Ok(OfflineBroadcastCtx {
        blockchain,
        wallet: Arc::new(bdk_wallet),
        timeout: OFFLINE_BROADCAST_TIMEOUT,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastOutcome {
    /// Txid of the cached exit-tree transaction we tried to publish.
    pub parent_txid: String,
    /// Txid of the P2A anchor child built to bump it. `None` when the parent
    /// was already published or in dry-run mode and `bump_and_broadcast`
    /// short-circuited before constructing one.
    pub anchor_txid: Option<String>,
    /// Total fee paid by the anchor child (covers the parent + child via CPFP).
    pub fee_sat: u64,
    /// True when the parent was already in the mempool or confirmed — no
    /// broadcast was attempted, no fee was paid.
    pub already_published: bool,
    /// True when no real broadcast was sent. The anchor tx was constructed and
    /// the fee is accurate, but `broadcast_package` was skipped.
    pub dry_run: bool,
}

/// Fee-bump and broadcast a single cached exit-tree transaction. The parent
/// must be one of the cached pre-signed virtual TXs; this function builds a
/// P2A anchor child funded from the user's on-chain UTXOs and sends both as
/// a package. ASP-free.
async fn bump_and_broadcast(
    ctx: &OfflineBroadcastCtx,
    parent: &Transaction,
    dry_run: bool,
) -> Result<BroadcastOutcome, AppError> {
    use ark_client::wallet::OnchainWallet;
    use ark_client::Blockchain as _;
    use ark_core::unilateral_exit::build_anchor_tx;

    let parent_txid = parent.compute_txid();

    // Mempool or confirmed — nothing to do. Re-broadcasting a known tx wastes
    // the anchor fee and can surface a misleading "already known" error from
    // esplora.
    let already = tokio::time::timeout(ctx.timeout, ctx.blockchain.find_tx(&parent_txid))
        .await
        .map_err(|_| AppError::Wallet(format!("Timed out checking status of {parent_txid}")))?
        .map_err(|e| AppError::Wallet(format!("Failed to check status of {parent_txid}: {e}")))?
        .is_some();
    if already {
        return Ok(BroadcastOutcome {
            parent_txid: parent_txid.to_string(),
            anchor_txid: None,
            fee_sat: 0,
            already_published: true,
            dry_run,
        });
    }

    let fee_rate = tokio::time::timeout(ctx.timeout, ctx.blockchain.get_fee_rate())
        .await
        .map_err(|_| AppError::Wallet("Timed out fetching fee rate".into()))?
        .map_err(|e| AppError::Wallet(format!("Failed to get fee rate: {e}")))?;

    let change_address = ctx
        .wallet
        .get_onchain_address()
        .map_err(|e| AppError::Wallet(format!("Failed to get onchain address: {e}")))?;

    let wallet_for_select = Arc::clone(&ctx.wallet);
    let select_coins_fn = move |target_amount: bitcoin::Amount| {
        wallet_for_select.select_coins(target_amount).map_err(|e| {
            ark_core::Error::ad_hoc(format!("failed to select coins for anchor TX: {e}"))
        })
    };

    let mut psbt = build_anchor_tx(parent, change_address, fee_rate, select_coins_fn)
        .map_err(|e| AppError::Wallet(format!("Failed to build anchor tx: {e}")))?;

    ctx.wallet
        .sign(&mut psbt)
        .map_err(|e| AppError::Wallet(format!("Failed to sign anchor tx: {e}")))?;

    let child = psbt
        .clone()
        .extract_tx()
        .map_err(|e| AppError::Wallet(format!("Failed to extract anchor tx: {e}")))?;
    let anchor_txid = child.compute_txid();
    let fee_sat = compute_anchor_fee(&psbt, &child);

    if !dry_run {
        ctx.blockchain
            .broadcast_package(&[parent, &child])
            .await
            .map_err(|e| AppError::Wallet(format!("Failed to broadcast exit package: {e}")))?;
        info!(parent = %parent_txid, anchor = %anchor_txid, fee_sat, "broadcast unilateral exit package");
    } else {
        debug!(parent = %parent_txid, anchor = %anchor_txid, fee_sat, "dry-run anchor tx built (not broadcast)");
    }

    Ok(BroadcastOutcome {
        parent_txid: parent_txid.to_string(),
        anchor_txid: Some(anchor_txid.to_string()),
        fee_sat,
        already_published: false,
        dry_run,
    })
}

/// Total input value (witness UTXOs in the PSBT) minus total output value.
/// Saturating because a malformed PSBT shouldn't panic; downstream callers
/// can sanity-check.
fn compute_anchor_fee(psbt: &bitcoin::Psbt, child: &Transaction) -> u64 {
    let total_in: u64 = psbt
        .inputs
        .iter()
        .filter_map(|i| i.witness_utxo.as_ref().map(|u| u.value.to_sat()))
        .sum();
    let total_out: u64 = child.output.iter().map(|o| o.value.to_sat()).sum();
    total_in.saturating_sub(total_out)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnilateralExitPreflight {
    /// True iff `blockers` is empty. The frontend may still surface non-blocking
    /// hints (e.g. unusually low onchain balance) on top of this.
    pub ready: bool,
    /// Human-readable reasons the broadcast cannot proceed.
    pub blockers: Vec<String>,
    /// Confirmed BDK-wallet onchain BTC available for fee-bumping (sats). This
    /// is plain onchain, distinct from boarding outputs — those cannot fund
    /// the anchor child because they're locked by the boarding script.
    pub onchain_balance_sat: u64,
    /// Unconfirmed onchain BTC visible in the mempool. Doesn't unblock broadcast
    /// (fee-bumping needs a confirmed UTXO to spend) but lets the UI tell the
    /// user "your deposit was seen" while they wait the ~10 min for a block.
    pub onchain_pending_sat: u64,
    /// Plain onchain address the user should fund to enable fee-bumping. Only
    /// populated when the offline ctx builds successfully — `None` indicates a
    /// blocker upstream of the address (no cache, stale cache, network mismatch).
    pub onchain_address: Option<String>,
}

/// Quick gate that the recovery screen renders against. Cheap by design:
/// builds the offline ctx (which itself validates server_pk + network match),
/// best-effort syncs the BDK wallet, and reports the confirmed onchain balance.
/// The exact fee-bump cost is computed at broadcast time — pre-flight only
/// blocks the obvious "won't be able to pay anything" case.
#[tauri::command]
pub async fn unilateral_exit_preflight(
    app: tauri::AppHandle,
) -> Result<UnilateralExitPreflight, AppError> {
    use ark_client::wallet::OnchainWallet;

    let mut blockers = Vec::new();

    let cache = match read_cache(&app).await? {
        Some(c) => c,
        None => {
            blockers.push(
                "No recovery package cached. Refresh while connected to the ASP first.".into(),
            );
            return Ok(UnilateralExitPreflight {
                ready: false,
                blockers,
                onchain_balance_sat: 0,
                onchain_pending_sat: 0,
                onchain_address: None,
            });
        }
    };

    if cache.server_pk.is_none() {
        blockers.push(
            "Recovery package was cached before offline broadcast was supported. \
             Refresh while connected to enable."
                .into(),
        );
    }
    if cache.branches.is_empty() {
        blockers.push("Recovery package contains no transactions to broadcast.".into());
    }

    let wallet_data = super::wallet::read_wallet_data(&app).await?;
    if wallet_data.network != cache.network {
        blockers.push(format!(
            "Network mismatch: recovery package is for {}, wallet is on {}",
            cache.network, wallet_data.network
        ));
    }

    if !blockers.is_empty() {
        return Ok(UnilateralExitPreflight {
            ready: false,
            blockers,
            onchain_balance_sat: 0,
            onchain_pending_sat: 0,
            onchain_address: None,
        });
    }

    let (onchain_balance_sat, onchain_pending_sat, onchain_address) =
        match build_offline_broadcast_ctx(&app).await {
            Ok(ctx) => {
                // Best-effort sync with retries — on flaky mobile networks a single
                // sync often gets reset mid-handshake. The connected-wallet path
                // already has cached state from its background loop, so even if
                // every retry fails the balance is still correct.
                if let Err(e) = sync_wallet_with_retry(&ctx.wallet).await {
                    warn!("broadcast ctx sync failed after retries (continuing with cached state): {e}");
                }
                let bal = ctx.wallet.balance().ok();
                let confirmed = bal.as_ref().map(|b| b.confirmed.to_sat()).unwrap_or(0);
                let pending = bal
                    .as_ref()
                    .map(|b| b.trusted_pending.to_sat() + b.untrusted_pending.to_sat())
                    .unwrap_or(0);
                let address = ctx.wallet.get_onchain_address().ok().map(|a| a.to_string());
                if confirmed == 0 {
                    blockers.push(
                        "No confirmed plain-onchain BTC for fee-bumping. Boarding outputs cannot fund \
                         the anchor child — send sats to the wallet's plain onchain address below."
                            .into(),
                    );
                }
                (confirmed, pending, address)
            }
            Err(e) => {
                blockers.push(format!("Failed to prepare offline broadcast context: {e}"));
                (0, 0, None)
            }
        };

    Ok(UnilateralExitPreflight {
        ready: blockers.is_empty(),
        blockers,
        onchain_balance_sat,
        onchain_pending_sat,
        onchain_address,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitTxStatus {
    pub txid: String,
    pub confirmed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitBranchStatus {
    pub branch_index: usize,
    pub txs: Vec<ExitTxStatus>,
    /// Index within `txs` of the first non-confirmed transaction. `None` once
    /// every tx in the branch is confirmed on-chain.
    pub next_pending_index: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnilateralExitStatus {
    pub branches: Vec<ExitBranchStatus>,
}

/// Per-branch broadcast progress, queried fresh from esplora. Stateless on
/// the backend — the chain *is* the progress, so this is robust to crashes
/// and app restarts mid-broadcast.
#[tauri::command]
pub async fn unilateral_exit_status(
    app: tauri::AppHandle,
) -> Result<UnilateralExitStatus, AppError> {
    use ark_client::Blockchain as _;

    let cache = read_cache(&app)
        .await?
        .ok_or_else(|| AppError::Wallet("No recovery package cached.".into()))?;
    let ctx = build_offline_broadcast_ctx(&app).await?;

    let mut branches = Vec::with_capacity(cache.branches.len());
    for (branch_index, branch) in cache.branches.iter().enumerate() {
        let mut txs = Vec::with_capacity(branch.len());
        let mut next_pending_index: Option<usize> = None;

        for (i, cached_tx) in branch.iter().enumerate() {
            let txid: Txid = cached_tx
                .txid
                .parse()
                .map_err(|e| AppError::Wallet(format!("Invalid txid in cache: {e}")))?;
            let status = tokio::time::timeout(ctx.timeout, ctx.blockchain.get_tx_status(&txid))
                .await
                .map_err(|_| AppError::Wallet(format!("Timed out querying status of {txid}")))?
                .map_err(|e| AppError::Wallet(format!("Failed to query status of {txid}: {e}")))?;

            if status.confirmed_at.is_none() && next_pending_index.is_none() {
                next_pending_index = Some(i);
            }

            txs.push(ExitTxStatus {
                txid: cached_tx.txid.clone(),
                confirmed_at: status.confirmed_at,
            });
        }

        branches.push(ExitBranchStatus {
            branch_index,
            txs,
            next_pending_index,
        });
    }

    Ok(UnilateralExitStatus { branches })
}

/// Broadcast the next not-yet-published transaction in `branch_index`.
/// `dry_run: true` constructs the bumped anchor and reports the fee without
/// actually publishing — useful for the UI to show "this will cost X sats"
/// before the user confirms.
#[tauri::command(rename_all = "camelCase")]
pub async fn unilateral_exit_broadcast_next(
    app: tauri::AppHandle,
    branch_index: usize,
    dry_run: bool,
) -> Result<BroadcastOutcome, AppError> {
    use ark_client::Blockchain as _;

    let cache = read_cache(&app)
        .await?
        .ok_or_else(|| AppError::Wallet("No recovery package cached.".into()))?;
    let branch = cache.branches.get(branch_index).ok_or_else(|| {
        AppError::Wallet(format!(
            "Branch {branch_index} not found in recovery package"
        ))
    })?;

    let ctx = build_offline_broadcast_ctx(&app).await?;
    if let Err(e) = sync_wallet_with_retry(&ctx.wallet).await {
        warn!("broadcast ctx sync failed after retries (continuing with cached state): {e}");
    }

    for cached_tx in branch {
        let txid: Txid = cached_tx
            .txid
            .parse()
            .map_err(|e| AppError::Wallet(format!("Invalid txid in cache: {e}")))?;

        // Skip anything already in the mempool or confirmed — we only ever
        // broadcast the *first* unpublished tx, never re-broadcast.
        let already = tokio::time::timeout(ctx.timeout, ctx.blockchain.find_tx(&txid))
            .await
            .map_err(|_| AppError::Wallet(format!("Timed out checking status of {txid}")))?
            .map_err(|e| AppError::Wallet(format!("Failed to check status of {txid}: {e}")))?
            .is_some();
        if already {
            continue;
        }

        let parent: Transaction = encode::deserialize_hex(&cached_tx.tx_hex)
            .map_err(|e| AppError::Wallet(format!("Invalid cached tx hex for {txid}: {e}")))?;
        return bump_and_broadcast(&ctx, &parent, dry_run).await;
    }

    // Every tx in the branch is on-chain — exit tree is fully published for
    // this VTXO. The post-CSV sweep is a separate flow.
    Ok(BroadcastOutcome {
        parent_txid: String::new(),
        anchor_txid: None,
        fee_sat: 0,
        already_published: true,
        dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_core::server::{ChainedTxType, VtxoChain, VtxoChains};

    /// A distinct, valid 32-byte txid for tests, every byte set to `n`.
    fn txid(n: u8) -> Txid {
        use bitcoin::hashes::Hash as _;
        Txid::from_byte_array([n; 32])
    }

    fn node(id: u8, tx_type: ChainedTxType, spends: &[u8]) -> VtxoChain {
        VtxoChain {
            txid: txid(id),
            tx_type,
            spends: spends.iter().map(|&n| txid(n)).collect(),
            expires_at: 0,
        }
    }

    /// Index of `t` within `order`, for asserting relative ordering.
    fn pos(order: &[Txid], t: u8) -> usize {
        order
            .iter()
            .position(|x| *x == txid(t))
            .expect("txid in order")
    }

    #[test]
    fn linear_chain_orders_parents_before_children() {
        // commitment(1) <- tree(2) <- ark(3, the VTXO)
        let chains = VtxoChains {
            inner: vec![
                node(1, ChainedTxType::Commitment, &[]),
                node(2, ChainedTxType::Tree, &[1]),
                node(3, ChainedTxType::Ark, &[2]),
            ],
        };
        let (order, commitments) = build_exit_broadcast_order(&chains, txid(3)).unwrap();
        // The commitment is already on-chain — excluded from the broadcast order.
        assert_eq!(order, vec![txid(2), txid(3)]);
        assert_eq!(commitments, vec![txid(1)]);
    }

    #[test]
    fn diamond_dag_emits_each_node_once_in_topological_order() {
        // commitment(1) <- b(2) <- x(3) ┐
        //                  b(2) <- y(4) ┴<- a(5, the VTXO)
        let chains = VtxoChains {
            inner: vec![
                node(1, ChainedTxType::Commitment, &[]),
                node(2, ChainedTxType::Checkpoint, &[1]),
                node(3, ChainedTxType::Ark, &[2]),
                node(4, ChainedTxType::Ark, &[2]),
                node(5, ChainedTxType::Ark, &[3, 4]),
            ],
        };
        let (order, commitments) = build_exit_broadcast_order(&chains, txid(5)).unwrap();
        // The shared ancestor (2) appears exactly once despite two children.
        assert_eq!(order.len(), 4);
        assert!(pos(&order, 2) < pos(&order, 3));
        assert!(pos(&order, 2) < pos(&order, 4));
        assert!(pos(&order, 3) < pos(&order, 5));
        assert!(pos(&order, 4) < pos(&order, 5));
        assert_eq!(commitments, vec![txid(1)]);
    }

    #[test]
    fn cycle_is_rejected() {
        let chains = VtxoChains {
            inner: vec![
                node(2, ChainedTxType::Ark, &[3]),
                node(3, ChainedTxType::Ark, &[2]),
            ],
        };
        let err = build_exit_broadcast_order(&chains, txid(2)).unwrap_err();
        assert!(err.to_string().contains("cycle"));
    }

    #[test]
    fn missing_transaction_is_rejected() {
        // Node 2 spends 3, but 3 is absent from the chain the ASP returned.
        let chains = VtxoChains {
            inner: vec![node(2, ChainedTxType::Ark, &[3])],
        };
        let err = build_exit_broadcast_order(&chains, txid(2)).unwrap_err();
        assert!(err.to_string().contains("missing transaction"));
    }

    #[test]
    fn dead_end_without_commitment_is_rejected() {
        // A non-commitment transaction with no parents cannot reach the chain.
        let chains = VtxoChains {
            inner: vec![node(2, ChainedTxType::Ark, &[])],
        };
        let err = build_exit_broadcast_order(&chains, txid(2)).unwrap_err();
        assert!(err.to_string().contains("dead-ends"));
    }

    fn one_input_one_output_tx(
        input_value: u64,
        output_value: u64,
    ) -> (bitcoin::Psbt, Transaction) {
        use bitcoin::{
            absolute, transaction, Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness,
        };

        let unsigned_tx = Transaction {
            version: transaction::Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: txid(0),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(output_value),
                script_pubkey: ScriptBuf::new(),
            }],
        };

        let mut psbt = bitcoin::Psbt::from_unsigned_tx(unsigned_tx.clone()).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(input_value),
            script_pubkey: ScriptBuf::new(),
        });
        (psbt, unsigned_tx)
    }

    #[test]
    fn anchor_fee_subtracts_outputs_from_inputs() {
        // 2000 sats in (witness_utxo) - 900 sats out = 1100 sats fee.
        let (psbt, child) = one_input_one_output_tx(2000, 900);
        assert_eq!(compute_anchor_fee(&psbt, &child), 1100);
    }

    #[test]
    fn anchor_fee_treats_missing_witness_utxo_as_zero_input() {
        // A real anchor PSBT always has witness_utxo set; this guards against
        // a malformed input panicking via underflow.
        use bitcoin::{
            absolute, transaction, Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness,
        };
        let unsigned_tx = Transaction {
            version: transaction::Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: txid(0),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(500),
                script_pubkey: ScriptBuf::new(),
            }],
        };
        let psbt = bitcoin::Psbt::from_unsigned_tx(unsigned_tx.clone()).unwrap();
        // 0 in - 500 out → saturating_sub keeps us at 0 instead of underflowing.
        assert_eq!(compute_anchor_fee(&psbt, &unsigned_tx), 0);
    }

    #[test]
    fn anchor_fee_zero_when_inputs_equal_outputs() {
        let (psbt, child) = one_input_one_output_tx(1000, 1000);
        assert_eq!(compute_anchor_fee(&psbt, &child), 0);
    }
}
