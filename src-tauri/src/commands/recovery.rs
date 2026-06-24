use bitcoin::consensus::encode;
use bitcoin::{Transaction, Txid};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

/// Per-branch origin: which VTXO this branch exits, and how much it's worth.
/// Optional in the cache for back-compat with packages cached before this
/// field existed — those branches simply lack labelling on the UI side and
/// can be refreshed when convenient.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedBranchSource {
    outpoint: String,
    amount_sat: u64,
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
    #[serde(default)]
    branch_sources: Vec<CachedBranchSource>,
    /// Everything that may need sweeping after exit trees confirm: the current
    /// branch sources plus every VTXO the ASP already reports as unrolled.
    /// Captured at refresh time (while connected) so `unilateral_exit_sweep_status`
    /// can run offline — the whole point of the exit flow is that the ASP may
    /// be gone. `None`-equivalent (empty) for caches written before this field.
    #[serde(default)]
    sweep_candidates: Vec<CachedBranchSource>,
    /// Seconds-based CSV exit delay from the ASP's `server_info`, captured at
    /// refresh time. `None` for legacy caches or block-based-delay ASPs; both
    /// make offline sweep status unavailable until a refresh while connected.
    #[serde(default)]
    exit_delay_seconds: Option<u64>,
    /// ASP dust limit (sats) from `server_info`, captured at refresh time.
    #[serde(default)]
    dust_sat: Option<u64>,
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
    sources: Vec<CachedBranchSource>,
    /// VTXOs the ASP currently reports as unrolled — already-exited coins that
    /// are (or will be) awaiting sweep. Snapshotted here because the ASP won't
    /// be reachable when the sweep screen needs them.
    unrolled: Vec<CachedBranchSource>,
    failed_outpoints: Vec<String>,
    last_error: Option<String>,
}

fn now_unix() -> Result<i64, AppError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Wallet(format!("System clock error: {e}")))?;
    Ok(duration.as_secs() as i64)
}

/// Seconds-based CSV exit delay, or `None` when the ASP uses a block-based
/// delay (or an invalid relative locktime). v0.9.0 removed the SDK's
/// `unilateral_vtxo_exit_delay_seconds()` helper in favour of exposing the raw
/// `Sequence` on `server_info`, so callers can handle both delay kinds.
fn exit_delay_to_seconds(delay: bitcoin::Sequence) -> Option<u64> {
    match delay.to_relative_lock_time() {
        Some(bitcoin::relative::LockTime::Time(t)) => Some(t.value() as u64 * 512),
        _ => None,
    }
}

/// Inverse of [`exit_delay_to_seconds`]: rebuild the consensus `Sequence` from
/// the cached seconds value. Exact, because cached values are always computed
/// as `intervals * 512` from a time-based locktime.
fn exit_delay_from_seconds(seconds: u64) -> Option<bitcoin::Sequence> {
    let intervals = seconds / 512;
    if !seconds.is_multiple_of(512) || intervals > u16::MAX as u64 {
        return None;
    }
    Some(bitcoin::Sequence::from_512_second_intervals(
        intervals as u16,
    ))
}

/// Union of two candidate lists, deduped by outpoint; on duplicates the entry
/// from `primary` wins.
fn merge_sweep_candidates(
    primary: Vec<CachedBranchSource>,
    secondary: Vec<CachedBranchSource>,
) -> Vec<CachedBranchSource> {
    let mut seen = HashSet::new();
    primary
        .into_iter()
        .chain(secondary)
        .filter(|c| seen.insert(c.outpoint.clone()))
        .collect()
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
    use ark_core::unilateral_exit::{finalize_unilateral_exit_tree, UnilateralExitTree};

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

    // VtxoList groups unrolled VTXOs into `spent` alongside genuinely-spent
    // and swept ones — `is_unrolled` picks out the already-exited set. The ASP
    // keeps the flag forever, so this includes long-swept coins; sweep status
    // filters those out against esplora at display time.
    let unrolled = vtxo_list
        .spent()
        .filter(|v| v.is_unrolled)
        .map(|v| CachedBranchSource {
            outpoint: v.outpoint.to_string(),
            amount_sat: v.amount.to_sat(),
        })
        .collect::<Vec<_>>();

    let mut branches = Vec::new();
    let mut sources = Vec::new();
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

            // One dependency-ordered branch per VTXO. `finalize_unilateral_exit_tree`
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

            finalize_unilateral_exit_tree(&exit_tree, &commitment_txs).map_err(|e| {
                AppError::Wallet(format!("Failed to sign exit tree for {outpoint}: {e}"))
            })
        }
        .await;

        match branch_result {
            Ok(mut vtxo_branches) => {
                // Each VTXO produces one branch today (we pass a single ordered_psbts
                // list into UnilateralExitTree::new). Push one source per emitted
                // branch so `sources` and `branches` stay strictly parallel even if
                // that 1:1 invariant ever loosens upstream.
                let source = CachedBranchSource {
                    outpoint: outpoint.to_string(),
                    amount_sat: virtual_tx_outpoint.amount.to_sat(),
                };
                for _ in 0..vtxo_branches.len() {
                    sources.push(source.clone());
                }
                branches.append(&mut vtxo_branches);
            }
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
        sources,
        unrolled,
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

    let server_info = client
        .server_info()
        .map_err(|e| AppError::Wallet(format!("Failed to read ASP server info: {e}")))?;

    if result.branches.is_empty() && !result.failed_outpoints.is_empty() {
        return Ok(UnilateralExitCacheStatus {
            exists: false,
            generated_at: None,
            network: Some(server_info.network.to_string()),
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
    let (server_pk, _parity) = server_info.signer_pk.x_only_public_key();
    let cache = UnilateralExitCache {
        version: CACHE_VERSION,
        generated_at: now_unix()?,
        asp_digest: server_info.digest.clone(),
        network: server_info.network.to_string(),
        server_pk: Some(server_pk.to_string()),
        branch_count: cached_branches.len(),
        tx_count,
        failed_outpoints: result.failed_outpoints,
        branches: cached_branches,
        sweep_candidates: merge_sweep_candidates(result.sources.clone(), result.unrolled),
        branch_sources: result.sources,
        exit_delay_seconds: exit_delay_to_seconds(server_info.unilateral_exit_delay),
        dust_sat: Some(server_info.dust.to_sat()),
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
    pub(crate) submitpackage: Option<SubmitpackageEndpoint>,
}

#[derive(Clone)]
pub(crate) struct SubmitpackageEndpoint {
    pub(crate) url: String,
    pub(crate) token: Option<String>,
}

const DEFAULT_SUBMITPACKAGE_URL: Option<&str> = option_env!("AVARK_SUBMITPACKAGE_URL");
const DEFAULT_SUBMITPACKAGE_TOKEN: Option<&str> = option_env!("AVARK_SUBMITPACKAGE_TOKEN");

/// An endpoint needs a URL; the token is optional.
fn endpoint_from_parts(
    url: Option<String>,
    token: Option<String>,
) -> Option<SubmitpackageEndpoint> {
    let url = url.filter(|u| !u.is_empty())?;
    let token = token.filter(|t| !t.is_empty());
    Some(SubmitpackageEndpoint { url, token })
}

pub(crate) fn default_submitpackage_endpoint(
    network: bitcoin::Network,
) -> Option<SubmitpackageEndpoint> {
    if network != bitcoin::Network::Bitcoin {
        return None;
    }
    endpoint_from_parts(
        DEFAULT_SUBMITPACKAGE_URL.map(str::to_owned),
        DEFAULT_SUBMITPACKAGE_TOKEN.map(str::to_owned),
    )
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

/// Resolve the submitpackage endpoint: a user override in settings wins;
/// otherwise the compiled-in default. `None` means broadcast falls back to
/// esplora's sequential `POST /tx` path.
async fn read_submitpackage_endpoint(
    app: &tauri::AppHandle,
    network: bitcoin::Network,
) -> Option<SubmitpackageEndpoint> {
    let settings = {
        let state = app.state::<SettingsLock>();
        let _lock = state.0.read().await;
        match crate::read_settings(app).await {
            Ok(s) => Some(s),
            Err(e) => {
                warn!(error = %e, "failed to read settings for submitpackage endpoint; using the compiled-in default");
                None
            }
        }
    };
    if let Some(s) = settings {
        if let Some(custom) = endpoint_from_parts(s.submitpackage_url, s.submitpackage_token) {
            return Some(custom);
        }
    }
    default_submitpackage_endpoint(network)
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
        let submitpackage = read_submitpackage_endpoint(app, network).await;
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
            submitpackage,
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

    let submitpackage = read_submitpackage_endpoint(app, network).await;

    Ok(OfflineBroadcastCtx {
        blockchain,
        wallet: Arc::new(bdk_wallet),
        timeout: OFFLINE_BROADCAST_TIMEOUT,
        submitpackage,
    })
}

/// POST the parent+child hex pair to a configured submitpackage endpoint.
/// The endpoint is expected to be a thin proxy in front of Bitcoin Core's
/// `submitpackage` RPC — it accepts `{"hex": ["parent", "child"]}` with a
/// bearer token and returns the JSON-RPC response from Core.
async fn broadcast_via_submitpackage(
    endpoint: &SubmitpackageEndpoint,
    txs: &[&Transaction],
    timeout: Duration,
) -> Result<(), AppError> {
    let hex: Vec<String> = txs.iter().map(encode::serialize_hex).collect();

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| AppError::Wallet(format!("Failed to build HTTP client: {e}")))?;

    let mut request = client
        .post(&endpoint.url)
        .json(&serde_json::json!({ "hex": hex }));
    if let Some(token) = &endpoint.token {
        request = request.bearer_auth(token);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| AppError::Wallet(format!("submitpackage request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(AppError::Wallet(format!(
            "submitpackage endpoint returned HTTP {status}: {body}"
        )));
    }

    check_submitpackage_response(&body).map_err(AppError::Wallet)?;

    info!(response = %body, "submitpackage endpoint accepted exit package");
    Ok(())
}

/// Interpret a submitpackage endpoint's response body. Core rejects packages
/// two different ways and both must be treated as failure:
///
/// 1. A top-level JSON-RPC `error` (malformed request, RPC-level failure).
/// 2. Since v27, per-transaction policy rejections are reported *inside*
///    `result` — HTTP 200, `error: null`, but `package_msg != "success"` and
///    the per-tx reasons in `tx-results[].error`. Missing this shape would
///    report a rejected exit package as broadcast.
///
/// `package_msg: "success"` means every tx is in (or already was in) the
/// mempool. A `result` without `package_msg` is accepted for proxies that
/// reshape the response.
fn check_submitpackage_response(body: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("submitpackage returned invalid JSON: {e}"))?;

    if let Some(err) = parsed.get("error").filter(|v| !v.is_null()) {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Bitcoin Core rejected exit package: {msg}"));
    }

    // Tolerate a proxy returning Core's bare result instead of the full
    // JSON-RPC envelope.
    let result = parsed.get("result").unwrap_or(&parsed);
    if let Some(msg) = result.get("package_msg").and_then(|m| m.as_str()) {
        if msg != "success" {
            let tx_errors = result
                .get("tx-results")
                .and_then(|t| t.as_object())
                .map(|txs| {
                    txs.values()
                        .filter_map(|r| r.get("error").and_then(|e| e.as_str()))
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default();
            return Err(if tx_errors.is_empty() {
                format!("Bitcoin Core rejected exit package: {msg}")
            } else {
                format!("Bitcoin Core rejected exit package: {msg} ({tx_errors})")
            });
        }
    }

    Ok(())
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
        match &ctx.submitpackage {
            Some(endpoint) => {
                broadcast_via_submitpackage(endpoint, &[parent, &child], ctx.timeout).await?;
                info!(parent = %parent_txid, anchor = %anchor_txid, fee_sat, "broadcast exit package via submitpackage endpoint");
            }
            None => {
                // Falls through to esplora's sequential broadcast. This will
                // fail on mainnet for TRUC + P2A packages with `-22 min relay
                // fee not met`; configuring a submitpackage endpoint in
                // Settings is the practical way to actually publish.
                ctx.blockchain
                    .broadcast_package(&[parent, &child])
                    .await
                    .map_err(|e| {
                        AppError::Wallet(format!("Failed to broadcast exit package: {e}"))
                    })?;
                info!(parent = %parent_txid, anchor = %anchor_txid, fee_sat, "broadcast exit package via esplora");
            }
        }
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

/// Blocker text for the onchain fee-bumping balance, or `None` if a confirmed
/// balance exists. Distinguishes "deposit needed" from "your own fee-bump
/// change is still in the mempool" — after each broadcast the anchor child
/// returns change unconfirmed, and telling the user to deposit during that
/// window is wrong (it confirms in the same block as the exit tx).
fn onchain_funding_blocker(confirmed_sat: u64, pending_sat: u64) -> Option<String> {
    if confirmed_sat > 0 {
        return None;
    }
    if pending_sat > 0 {
        return Some(format!(
            "Onchain balance is awaiting confirmation ({pending_sat} sats pending) — usually \
             change from your last fee-bump. It becomes spendable once it confirms (~1 block); \
             no new deposit is needed."
        ));
    }
    Some(
        "No confirmed plain-onchain BTC for fee-bumping. Boarding outputs cannot fund \
         the anchor child — send sats to the wallet's plain onchain address below."
            .into(),
    )
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
    // Set only by blockers that `build_offline_broadcast_ctx` independently
    // fails on (no cache, missing server_pk, network mismatch)
    let mut ctx_failure_expected = false;

    let cache = read_cache(&app).await?;

    let has_branches = match &cache {
        None => {
            blockers.push(
                "No recovery package cached. Refresh while connected to the ASP first.".into(),
            );
            ctx_failure_expected = true;
            false
        }
        Some(cache) => {
            if cache.server_pk.is_none() {
                blockers.push(
                    "Recovery package was cached before offline broadcast was supported. \
                     Refresh while connected to enable."
                        .into(),
                );
                ctx_failure_expected = true;
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
                ctx_failure_expected = true;
            }
            !cache.branches.is_empty()
        }
    };

    // The balance is informational and independent of the cache blockers
    // above — compute it whenever a wallet context can be built, so the UI
    // never renders a "0 sats" placeholder over real funds (e.g. fee-bump
    // change sitting in the wallet after the last branch finished).
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
                // An empty wallet only blocks when there's something left to
                // broadcast — prompting for a deposit otherwise is noise.
                if has_branches {
                    if let Some(blocker) = onchain_funding_blocker(confirmed, pending) {
                        blockers.push(blocker);
                    }
                }
                (confirmed, pending, address)
            }
            Err(e) => {
                if !ctx_failure_expected {
                    blockers.push(format!("Failed to prepare offline broadcast context: {e}"));
                }
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
    /// Source VTXO outpoint (e.g. `txid:vout`) this branch exits. `None` for
    /// branches cached before the source-tracking field existed — a fresh
    /// `refresh_unilateral_exit_cache` populates it.
    pub source_outpoint: Option<String>,
    /// Amount of the source VTXO in sats. `None` for legacy cache entries.
    pub source_amount_sat: Option<u64>,
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

    // Fan all tx-status fetches across all branches out concurrently. A real
    // recovery package on mainnet can contain dozens of cached txs and esplora
    // round-trips dominate latency on mobile networks; the previous serial loop
    // turned this command into an 80s+ wait. `join_all` preserves input order,
    // so the flat results come back branch-major and chunk straight back into
    // branches by taking `branch.len()` at a time.
    let blockchain = &ctx.blockchain;
    let timeout = ctx.timeout;
    let tx_futures = cache.branches.iter().flatten().map(|cached_tx| {
        let cached_txid = cached_tx.txid.clone();
        async move {
            let txid: Txid = cached_txid
                .parse()
                .map_err(|e| AppError::Wallet(format!("Invalid txid in cache: {e}")))?;
            let status = tokio::time::timeout(timeout, blockchain.get_tx_status(&txid))
                .await
                .map_err(|_| AppError::Wallet(format!("Timed out querying status of {txid}")))?
                .map_err(|e| AppError::Wallet(format!("Failed to query status of {txid}: {e}")))?;
            Ok::<_, AppError>(ExitTxStatus {
                txid: cached_txid,
                confirmed_at: status.confirmed_at,
            })
        }
    });

    let mut results = futures_util::future::join_all(tx_futures)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter();

    let branches = cache
        .branches
        .iter()
        .enumerate()
        .map(|(branch_index, branch)| {
            let txs: Vec<_> = results.by_ref().take(branch.len()).collect();
            let next_pending_index = txs.iter().position(|t| t.confirmed_at.is_none());
            let source = cache.branch_sources.get(branch_index);
            ExitBranchStatus {
                branch_index,
                txs,
                next_pending_index,
                source_outpoint: source.map(|s| s.outpoint.clone()),
                source_amount_sat: source.map(|s| s.amount_sat),
            }
        })
        .collect();

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrolledVtxoMaturity {
    pub txid: String,
    pub vout: u32,
    pub amount_sat: u64,
    /// Block timestamp of the exit leaf tx's first confirmation. `None` while
    /// the tx is still in the mempool.
    pub confirmed_at: Option<i64>,
    /// Unix timestamp at which the CSV expires and the VTXO becomes spendable
    /// via the unilateral exit script. Computed as `confirmed_at + csv_delay`.
    pub csv_mature_at: Option<i64>,
    /// True iff `csv_mature_at <= now()` — the VTXO is sweep-ready right now.
    pub mature: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitSweepStatus {
    /// CSV delay captured into the recovery cache at refresh time. Seconds
    /// after the exit leaf confirms before the VTXO output becomes spendable.
    pub csv_delay_seconds: u64,
    /// Reference time used for `mature` flags; lets the UI render countdowns
    /// against one clock reading instead of re-sampling device time.
    pub now: i64,
    /// ASP dust limit captured into the recovery cache at refresh time. The
    /// SDK's `send_on_chain` rejects sweep amounts below this, so the UI must
    /// not offer them.
    pub dust_sat: u64,
    /// All exited (unrolled) VTXOs awaiting sweep.
    pub vtxos: Vec<UnrolledVtxoMaturity>,
}

/// Per-VTXO post-broadcast sweep maturity, computed offline from the cached
/// recovery package plus esplora — no ASP connection required, matching the
/// rest of the emergency-exit flow (the ASP being gone is the reason this
/// screen exists). The CSV delay, dust limit, and candidate outpoints are
/// captured into the cache at refresh time, while connected; esplora answers
/// "is it on-chain / since when / still unspent" at call time.
#[tauri::command]
pub async fn unilateral_exit_sweep_status(
    app: tauri::AppHandle,
) -> Result<ExitSweepStatus, AppError> {
    use ark_client::Blockchain as _;

    let cache = read_cache(&app).await?.ok_or_else(|| {
        AppError::Wallet(
            "No recovery package cached. Refresh while connected to the ASP first.".into(),
        )
    })?;
    let (csv_delay_seconds, dust_sat) = match (cache.exit_delay_seconds, cache.dust_sat) {
        (Some(delay), Some(dust)) => (delay, dust),
        _ => {
            return Err(AppError::Wallet(
                "Recovery package predates offline sweep support — refresh once while \
                 connected to the ASP. (Or the ASP uses a block-based exit delay, which \
                 avark's sweep flow doesn't support yet.)"
                    .into(),
            ));
        }
    };

    // `sweep_candidates` is the full set when written by current code;
    // chaining `branch_sources` covers caches written in between the two
    // fields existing. Spent/never-broadcast entries are filtered below.
    let candidates = merge_sweep_candidates(cache.sweep_candidates, cache.branch_sources);

    let ctx = build_offline_broadcast_ctx(&app).await?;
    let now = now_unix()?;

    // One future per candidate, all in flight at once with per-call timeouts
    // (same treatment as `unilateral_exit_status`): serial esplora round-trips
    // sum painfully on mobile networks, and a call that never answers must not
    // hang the command.
    let blockchain = &ctx.blockchain;
    let timeout = ctx.timeout;
    let maturity_futures = candidates.iter().map(|c| async move {
        let outpoint: bitcoin::OutPoint = match c.outpoint.parse() {
            Ok(o) => o,
            Err(e) => {
                warn!(outpoint = %c.outpoint, %e, "invalid outpoint in recovery cache");
                return None;
            }
        };

        // Is the exit leaf on-chain at all, and since when? `get_tx_status`
        // reports both "unknown tx" and "in mempool" as unconfirmed, so the
        // unconfirmed case needs `find_tx` to tell "broadcast, awaiting
        // confirmation" (list it) from "exit not broadcast yet" (skip — the
        // broadcast flow owns that state, and advertising it as awaiting
        // sweep would be misleading). Skipping on error/timeout is safe:
        // the UI polls, so a transient esplora failure self-heals.
        let confirmed_at =
            match tokio::time::timeout(timeout, blockchain.get_tx_status(&outpoint.txid)).await {
                Ok(Ok(s)) => s.confirmed_at,
                Ok(Err(e)) => {
                    warn!(outpoint = %c.outpoint, %e, "failed to query exit leaf status");
                    return None;
                }
                Err(_) => {
                    warn!(outpoint = %c.outpoint, "timed out querying exit leaf status");
                    return None;
                }
            };
        if confirmed_at.is_none() {
            match tokio::time::timeout(timeout, blockchain.find_tx(&outpoint.txid)).await {
                Ok(Ok(Some(_))) => {} // in mempool — list with confirmed_at: None
                Ok(Ok(None)) => return None, // exit not broadcast yet
                Ok(Err(e)) => {
                    warn!(outpoint = %c.outpoint, %e, "failed to check exit leaf existence");
                    return None;
                }
                Err(_) => {
                    warn!(outpoint = %c.outpoint, "timed out checking exit leaf existence");
                    return None;
                }
            }
        }

        // A spent outpoint means the coin left this wallet either way: a sweep
        // we made, or — if the VTXO had been spent offchain before the (stale)
        // exit tree was broadcast — a counterparty's pre-signed checkpoint tx
        // claiming the output for them. Neither is ours to sweep, so drop it
        // instead of advertising funds the SDK's coin selection will rightly
        // refuse.
        let spend_txid = match tokio::time::timeout(
            timeout,
            blockchain.get_output_status(&outpoint.txid, outpoint.vout),
        )
        .await
        {
            Ok(Ok(s)) => s.spend_txid,
            // Can't verify spentness (error or timeout) — list the coin
            // anyway rather than hiding possibly-sweepable funds.
            Ok(Err(e)) => {
                warn!(outpoint = %c.outpoint, %e, "failed to check unrolled outpoint spend status");
                None
            }
            Err(_) => {
                warn!(outpoint = %c.outpoint, "timed out checking unrolled outpoint spend status");
                None
            }
        };
        if let Some(spend_txid) = spend_txid {
            debug!(outpoint = %c.outpoint, %spend_txid, "unrolled outpoint already spent; not sweepable");
            return None;
        }

        let csv_mature_at = confirmed_at.map(|t| t + csv_delay_seconds as i64);
        let mature = csv_mature_at.is_some_and(|t| t <= now);
        Some(UnrolledVtxoMaturity {
            txid: outpoint.txid.to_string(),
            vout: outpoint.vout,
            amount_sat: c.amount_sat,
            confirmed_at,
            csv_mature_at,
            mature,
        })
    });
    let vtxos: Vec<UnrolledVtxoMaturity> = futures_util::future::join_all(maturity_futures)
        .await
        .into_iter()
        .flatten()
        .collect();

    Ok(ExitSweepStatus {
        csv_delay_seconds,
        now,
        dust_sat,
        vtxos,
    })
}

/// Upper bound on VTXO owner-key derivation indices pre-derived into the local
/// lookup map. Derivation is local-only (no network), so this is generous. It is
/// only a *fast path*: when connected, a miss falls back to the live key
/// provider's `get_keypair_for_pk`, which searches up to the wallet's real
/// high-water mark — so there is no ceiling online. Offline (no live provider) a
/// key beyond this bound is logged and skipped, since there's no cached
/// high-water mark to search against.
const MAX_VTXO_KEY_SCAN: u32 = 1_000;

/// Relative (CSV) timelocks are enforced by consensus against a block's
/// median-time-past, which lags wall-clock by up to ~2h. Maturity is judged
/// against `now - MTP_SAFETY_MARGIN` so a sweep is never built that's final by
/// wall-clock but non-final by MTP (which the relay would reject as non-BIP68).
const MTP_SAFETY_MARGIN: Duration = Duration::from_secs(2 * 60 * 60);

/// A single sweep input, reduced to the raw parts needed to build + sign the
/// taproot exit-script spend (boarding outputs and unrolled VTXOs both reduce
/// to this shape).
struct SweepInput {
    outpoint: bitcoin::OutPoint,
    sequence: bitcoin::Sequence,
    witness_utxo: bitcoin::TxOut,
    exit_script: bitcoin::ScriptBuf,
    control_block: bitcoin::taproot::ControlBlock,
}

/// Absolute fee for a sweep of `vsize` vbytes at `fee_rate_sat_vb`, floored at
/// 1 sat/vB so it always clears the relay minimum. The SDK's `send_on_chain`
/// (and `create_unilateral_exit_transaction`) reserve **no** fee — they send
/// every input sat to the destination + change, producing a 0-fee tx the relay
/// rejects ("min relay fee not met"). avark builds the sweep itself and sizes
/// the fee from the live fee rate instead. See upstream-send-on-chain-fee-issue.md.
fn sweep_fee(vsize: u64, fee_rate_sat_vb: f64) -> bitcoin::Amount {
    let rate = if fee_rate_sat_vb.is_finite() && fee_rate_sat_vb > 1.0 {
        fee_rate_sat_vb
    } else {
        1.0
    };
    bitcoin::Amount::from_sat(((vsize as f64) * rate).ceil() as u64)
}

/// Build and sign the sweep transaction. Mirrors ark-core's
/// `create_unilateral_exit_transaction` (the proven taproot script-path
/// signing sequence) but reserves `fee` from the change instead of producing a
/// 0-fee transaction. Change below `dust` is dropped (rolled into the fee).
fn build_sweep_tx<S>(
    to_address: &bitcoin::Address,
    to_amount: bitcoin::Amount,
    change_address: &bitcoin::Address,
    fee: bitcoin::Amount,
    dust: bitcoin::Amount,
    inputs: &[SweepInput],
    sign_fn: S,
) -> Result<Transaction, AppError>
where
    S: Fn(
        &mut bitcoin::psbt::Input,
        bitcoin::secp256k1::Message,
    ) -> Result<
        Vec<(
            bitcoin::secp256k1::schnorr::Signature,
            bitcoin::XOnlyPublicKey,
        )>,
        ark_core::Error,
    >,
{
    use bitcoin::hashes::Hash as _;
    use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
    use bitcoin::taproot::TapLeafHash;

    if inputs.is_empty() {
        return Err(AppError::Wallet("No inputs to sweep".into()));
    }

    let total: bitcoin::Amount = inputs.iter().map(|i| i.witness_utxo.value).sum();
    let spend = to_amount + fee;
    let change = total.checked_sub(spend).ok_or_else(|| {
        AppError::Wallet(format!(
            "Insufficient funds for sweep: need {spend} (amount {to_amount} + fee {fee}), have {total}"
        ))
    })?;

    let mut output = vec![bitcoin::TxOut {
        value: to_amount,
        script_pubkey: to_address.script_pubkey(),
    }];
    // Change below dust is uneconomical to create — leave it in the fee.
    if change >= dust {
        output.push(bitcoin::TxOut {
            value: change,
            script_pubkey: change_address.script_pubkey(),
        });
    }

    let input = inputs
        .iter()
        .map(|i| bitcoin::TxIn {
            previous_output: i.outpoint,
            sequence: i.sequence,
            ..Default::default()
        })
        .collect();

    let mut psbt = bitcoin::psbt::Psbt::from_unsigned_tx(Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input,
        output,
    })
    .map_err(|e| AppError::Wallet(format!("Failed to build sweep PSBT: {e}")))?;

    // Attach witness_utxo + the taproot exit leaf for every input.
    for (i, pin) in psbt.inputs.iter_mut().enumerate() {
        let si = &inputs[i];
        pin.witness_utxo = Some(si.witness_utxo.clone());
        let leaf_version = si.control_block.leaf_version;
        pin.tap_scripts.insert(
            si.control_block.clone(),
            (si.exit_script.clone(), leaf_version),
        );
    }

    let prevouts = inputs
        .iter()
        .map(|i| i.witness_utxo.clone())
        .collect::<Vec<_>>();
    let secp = bitcoin::key::Secp256k1::new();

    for (i, pin) in psbt.inputs.iter_mut().enumerate() {
        let (control_block, (exit_script, leaf_version)) = pin
            .tap_scripts
            .pop_first()
            .ok_or_else(|| AppError::Wallet(format!("No exit script for sweep input {i}")))?;

        pin.witness_script = Some(exit_script.clone());

        let leaf_hash = TapLeafHash::from_script(&exit_script, leaf_version);
        let sighash = SighashCache::new(&psbt.unsigned_tx)
            .taproot_script_spend_signature_hash(
                i,
                &Prevouts::All(&prevouts),
                leaf_hash,
                TapSighashType::Default,
            )
            .map_err(|e| AppError::Wallet(format!("Failed to compute sweep sighash: {e}")))?;
        let msg = bitcoin::secp256k1::Message::from_digest(sighash.to_raw_hash().to_byte_array());

        let sigs = sign_fn(pin, msg)
            .map_err(|e| AppError::Wallet(format!("Failed to sign sweep input {i}: {e}")))?;

        let mut witness: Vec<Vec<u8>> = Vec::new();
        for (sig, pk) in sigs.iter() {
            secp.verify_schnorr(sig, &msg, pk).map_err(|e| {
                AppError::Wallet(format!("Sweep signature failed verification: {e}"))
            })?;
            witness.push(sig[..].to_vec());
        }
        witness.push(exit_script.as_bytes().to_vec());
        witness.push(control_block.serialize());
        pin.final_script_witness = Some(bitcoin::Witness::from_slice(&witness));
    }

    psbt.extract_tx()
        .map_err(|e| AppError::Wallet(format!("Failed to extract sweep tx: {e}")))
}

/// Offline replica of the SDK's `Client::send_on_chain` (which hard-requires a
/// connected client even though — per the SDK's own TODO — nothing about a
/// unilateral exit needs the server). Everything it consumes is available
/// without the ASP: the server pubkey + exit delay + dust snapshotted into the
/// recovery cache at refresh time, keys derived locally from the mnemonic,
/// boarding outputs from the local wallet DB, and esplora for UTXO lookup +
/// broadcast. VTXO addresses are discovered by deriving keys at consecutive
/// indices and checking esplora for on-chain history, stopping after a
/// gap-limit run of unused keys — the esplora analogue of the SDK's
/// ASP-backed `discover_keys`.
async fn sweep_unrolled(
    app: &tauri::AppHandle,
    client: Option<Arc<ark::ArkClient>>,
    // The live key provider when connected: its `get_keypair_for_pk` searches up
    // to the wallet's real high-water mark (and hits the populated cache), so a
    // VTXO whose owner key sits beyond MAX_VTXO_KEY_SCAN is still resolvable.
    live_key_provider: Option<Arc<ark_client::Bip32KeyProvider>>,
    to_address: bitcoin::Address,
    to_amount: bitcoin::Amount,
) -> Result<Txid, AppError> {
    use ark_client::wallet::{BoardingWallet, OnchainWallet};
    use ark_client::{Blockchain as _, KeyProvider as _};
    use ark_core::script::extract_checksig_pubkeys;
    use ark_core::{ExplorerUtxo, Vtxo};

    let cache = read_cache(app).await?.ok_or_else(|| {
        AppError::Wallet(
            "No recovery package cached. Refresh while connected to the ASP first.".into(),
        )
    })?;
    let (server_pk_hex, exit_delay_seconds, dust_sat) =
        match (&cache.server_pk, cache.exit_delay_seconds, cache.dust_sat) {
            (Some(pk), Some(delay), Some(dust)) => (pk.clone(), delay, dust),
            _ => {
                return Err(AppError::Wallet(
                    "Recovery package predates offline sweep support — refresh once while \
                     connected to the ASP."
                        .into(),
                ));
            }
        };
    let server_pk: bitcoin::XOnlyPublicKey = server_pk_hex
        .parse()
        .map_err(|e| AppError::Wallet(format!("Invalid server_pk in cache: {e}")))?;

    if to_amount < bitcoin::Amount::from_sat(dust_sat) {
        return Err(AppError::Wallet(format!(
            "Amount below the dust limit of {dust_sat} sats"
        )));
    }

    let exit_delay = exit_delay_from_seconds(exit_delay_seconds).ok_or_else(|| {
        AppError::Wallet(format!(
            "Invalid cached exit delay: {exit_delay_seconds}s is not a valid time-based locktime"
        ))
    })?;

    let wallet_data = super::wallet::read_wallet_data(app).await?;
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network in wallet.json: {e}")))?;

    let ctx = build_offline_broadcast_ctx(app).await?;

    let store = secure_storage::SecureStorage::get_instance(app);
    let mnemonic_words = load_mnemonic(store)?;
    let xpriv = wallet::derive_master_xpriv(&mnemonic_words, network)
        .map_err(|e| AppError::Wallet(e.to_string()))?;
    let derivation_path = std::str::FromStr::from_str(ark_core::DEFAULT_DERIVATION_PATH)
        .expect("valid derivation path");
    // start_index 0 is fine: we never derive *new* keys here, only enumerate
    // existing ones via discovery indices.
    let key_provider = ark_client::Bip32KeyProvider::new_with_index(xpriv, derivation_path, 0);

    let now = Duration::from_secs(now_unix()? as u64);
    // Conservative "now" for maturity: see MTP_SAFETY_MARGIN. Used for both
    // boarding outputs and VTXOs so the two input classes apply one rule.
    let mature_now = now.saturating_sub(MTP_SAFETY_MARGIN);
    let mut selected = bitcoin::Amount::ZERO;

    // Select *all* mature outputs rather than stopping at a fixed headroom: the
    // network fee is sized dynamically below, and a fixed headroom (e.g. 1000
    // sats) silently strands inputs whenever the real fee is larger, making a
    // near-max sweep impossible exactly when fees are high. Each extra input adds
    // far more value than its marginal fee, so taking them all maximises the
    // headroom available to cover the fee. The requested amount is clamped to
    // what's actually left after the fee.
    let mut inputs: Vec<SweepInput> = Vec::new();
    for boarding_output in ctx
        .wallet
        .get_boarding_outputs()
        .map_err(|e| AppError::Wallet(format!("Failed to list boarding outputs: {e}")))?
    {
        let utxos = tokio::time::timeout(
            ctx.timeout,
            ctx.blockchain.find_outpoints(boarding_output.address()),
        )
        .await
        .map_err(|_| AppError::Wallet("Timed out querying boarding outputs".into()))?
        .map_err(|e| AppError::Wallet(format!("Failed to query boarding outputs: {e}")))?;

        for utxo in utxos {
            if let ExplorerUtxo {
                outpoint,
                amount,
                confirmation_blocktime: Some(blocktime),
                confirmations,
                is_spent: false,
            } = utxo
            {
                if boarding_output.can_be_claimed_unilaterally_by_owner(
                    mature_now,
                    Duration::from_secs(blocktime),
                    confirmations,
                ) {
                    let (exit_script, control_block) = boarding_output.exit_spend_info();
                    inputs.push(SweepInput {
                        outpoint,
                        sequence: boarding_output.exit_delay(),
                        witness_utxo: bitcoin::TxOut {
                            value: amount,
                            script_pubkey: boarding_output.address().script_pubkey(),
                        },
                        exit_script,
                        control_block,
                    });
                    selected += amount;
                }
            }
        }
    }

    // Then unrolled VTXOs. Discovery is driven by the *cached sweep candidates*
    // — the exact outpoints `unilateral_exit_sweep_status` surfaces to the UI —
    // not an on-chain address scan. A virtual VTXO key has no on-chain history
    // until it's unrolled, so a gap-limit scan keyed on on-chain presence bails
    // (after DEFAULT_GAP_LIMIT empties) long before reaching an unrolled VTXO at
    // a higher derivation index, finding nothing. We resolve each candidate's
    // scriptPubKey to a VTXO, then its owner key to a derived keypair.
    let secp = bitcoin::key::Secp256k1::new();
    let mut keypairs: HashMap<bitcoin::XOnlyPublicKey, bitcoin::key::Keypair> = HashMap::new();

    // owner pubkey -> keypair, for signing the exit-leaf spend. Derivation is
    // local (no network), so the bound can be generous.
    let mut owner_to_keypair: HashMap<bitcoin::XOnlyPublicKey, bitcoin::key::Keypair> =
        HashMap::new();
    for index in 0..MAX_VTXO_KEY_SCAN {
        let keypair = match key_provider
            .derive_at_discovery_index(index)
            .map_err(|e| AppError::Wallet(format!("Key derivation failed: {e}")))?
        {
            Some(kp) => kp,
            None => break,
        };
        owner_to_keypair.insert(keypair.x_only_public_key().0, keypair);
    }

    // scriptPubKey -> VTXO. When connected, use the client's authoritative
    // address set (`get_offchain_addresses` — exactly what the SDK's own
    // coin-selection uses), which covers every VTXO variant (default,
    // delegator, custom scripts). Offline, fall back to reconstructing the
    // default (2-leaf) VTXO per derived key — correct for ordinary receives,
    // though it can't reproduce non-default scripts without the ASP.
    let mut script_to_vtxo: HashMap<bitcoin::ScriptBuf, Vtxo> = HashMap::new();
    match &client {
        Some(client) => {
            for (_, vtxo) in client
                .get_offchain_addresses()
                .map_err(|e| AppError::Wallet(format!("Failed to list offchain addresses: {e}")))?
            {
                script_to_vtxo.insert(vtxo.script_pubkey(), vtxo);
            }
        }
        None => {
            for keypair in owner_to_keypair.values() {
                let owner_pk = keypair.x_only_public_key().0;
                let vtxo = Vtxo::new_default(&secp, server_pk, owner_pk, exit_delay, network)
                    .map_err(|e| AppError::Wallet(format!("Failed to derive VTXO script: {e}")))?;
                script_to_vtxo.insert(vtxo.script_pubkey(), vtxo);
            }
        }
    }

    let candidates = merge_sweep_candidates(cache.sweep_candidates, cache.branch_sources);
    for candidate in &candidates {
        let outpoint: bitcoin::OutPoint = match candidate.outpoint.parse() {
            Ok(o) => o,
            Err(e) => {
                warn!(outpoint = %candidate.outpoint, %e, "invalid outpoint in recovery cache; skipping");
                continue;
            }
        };

        // The on-chain exit leaf: its scriptPubKey identifies the owner key, and
        // its value is needed for the (taproot) sighash.
        let tx = match tokio::time::timeout(ctx.timeout, ctx.blockchain.find_tx(&outpoint.txid))
            .await
            .map_err(|_| {
                AppError::Wallet(format!("Timed out fetching exit leaf {}", outpoint.txid))
            })?
            .map_err(|e| {
                AppError::Wallet(format!("Failed to fetch exit leaf {}: {e}", outpoint.txid))
            })? {
            Some(tx) => tx,
            None => continue, // exit leaf not on-chain yet
        };
        let txout = match tx.output.get(outpoint.vout as usize) {
            Some(o) => o.clone(),
            None => {
                warn!(outpoint = %candidate.outpoint, "cached outpoint vout out of range; skipping");
                continue;
            }
        };

        // Resolve the VTXO + its signing key first
        let vtxo = match script_to_vtxo.get(&txout.script_pubkey) {
            Some(v) => v,
            None => {
                warn!(
                    outpoint = %candidate.outpoint,
                    "no known VTXO matches this exit leaf; skipping (refresh while connected?)"
                );
                continue;
            }
        };
        let owner_pk = vtxo.owner_pk();
        // Fast path: the locally-derived 0..MAX_VTXO_KEY_SCAN map.
        let keypair = match owner_to_keypair.get(&owner_pk).copied().or_else(|| {
            live_key_provider
                .as_ref()
                .and_then(|kp| kp.get_keypair_for_pk(&owner_pk).ok())
        }) {
            Some(kp) => kp,
            None => {
                warn!(
                    outpoint = %candidate.outpoint, %owner_pk,
                    "no signing key for this VTXO's owner (beyond local scan window and \
                     no live key provider); skipping"
                );
                continue;
            }
        };

        // Already spent (our prior sweep, or a counterparty checkpoint) — not ours.
        let spend_txid = tokio::time::timeout(
            ctx.timeout,
            ctx.blockchain
                .get_output_status(&outpoint.txid, outpoint.vout),
        )
        .await
        .map_err(|_| {
            AppError::Wallet(format!(
                "Timed out checking spend status for {}",
                candidate.outpoint
            ))
        })?
        .map_err(|e| {
            AppError::Wallet(format!(
                "Failed to check spend status for {}: {e}",
                candidate.outpoint
            ))
        })?
        .spend_txid;
        if spend_txid.is_some() {
            continue;
        }

        // The VTXO's *own* CSV exit delay must have elapsed — the same per-output
        // rule the boarding path uses, against `mature_now` (MTP-margined), rather
        // than the cached server-wide delay against raw wall-clock.
        let confirmed_at =
            tokio::time::timeout(ctx.timeout, ctx.blockchain.get_tx_status(&outpoint.txid))
                .await
                .map_err(|_| {
                    AppError::Wallet(format!(
                        "Timed out checking maturity for {}",
                        candidate.outpoint
                    ))
                })?
                .map_err(|e| {
                    AppError::Wallet(format!(
                        "Failed to check maturity for {}: {e}",
                        candidate.outpoint
                    ))
                })?
                .confirmed_at;
        let confirmed = match confirmed_at {
            Some(t) if t >= 0 => Duration::from_secs(t as u64),
            _ => continue,
        };
        if !vtxo.can_be_claimed_unilaterally_by_owner(mature_now, confirmed, 0) {
            continue;
        }

        let (exit_script, control_block) = vtxo
            .exit_spend_info()
            .map_err(|e| AppError::Wallet(format!("Failed to derive exit spend info: {e}")))?;
        let value = txout.value;
        inputs.push(SweepInput {
            outpoint,
            sequence: vtxo.exit_delay(),
            witness_utxo: txout,
            exit_script,
            control_block,
        });
        keypairs.insert(owner_pk, keypair);
        selected += value;
    }

    if inputs.is_empty() {
        return Err(AppError::Wallet(
            "No mature funds to sweep. Outputs still inside the exit delay are not selectable yet."
                .into(),
        ));
    }

    let change_address = ctx
        .wallet
        .get_onchain_address()
        .map_err(|e| AppError::Wallet(format!("Failed to derive change address: {e}")))?;

    let wallet = Arc::clone(&ctx.wallet);
    let sign = move |input: &mut bitcoin::psbt::Input, msg: bitcoin::secp256k1::Message| {
        let script = input.witness_script.as_ref().ok_or_else(|| {
            ark_core::Error::ad_hoc(
                "Missing witness script for psbt::Input when signing sweep transaction",
            )
        })?;
        let mut res = vec![];
        for pk in extract_checksig_pubkeys(script) {
            if let Some(keypair) = keypairs.get(&pk) {
                let sig = secp.sign_schnorr_no_aux_rand(&msg, keypair);
                res.push((sig, pk));
            }
            // Boarding inputs are signed by the wallet's own key; errors mean
            // "not this wallet's key", mirroring the SDK.
            if let Ok(sig) = wallet.sign_for_pk(&pk, &msg) {
                res.push((sig, pk));
            }
        }
        Ok(res)
    };

    let dust = bitcoin::Amount::from_sat(dust_sat);

    // Size the fee from the live fee rate. Build once at zero fee to measure the
    // signed vsize (taproot script-path inputs dominate it). The probe amount is
    // capped to `selected` so the build can't fail on an over-large output, and
    // it keeps a change output so the probe is never smaller than the final tx
    let probe_amount = to_amount.min(selected);
    let probe = build_sweep_tx(
        &to_address,
        probe_amount,
        &change_address,
        bitcoin::Amount::ZERO,
        dust,
        &inputs,
        &sign,
    )?;
    let vsize = probe.vsize() as u64;

    // Surface an estimate failure instead of silently broadcasting at the
    // relay-minimum: an under-priced emergency sweep can sit unconfirmed for a
    // long time while the exit output stays exposed. If esplora is reachable
    // enough to broadcast the sweep, it can answer this too (it retries
    // internally), so failing here is a transient-retry signal, not a dead end.
    let fee_rate = ctx.blockchain.get_fee_rate().await.map_err(|e| {
        AppError::Wallet(format!(
            "Couldn't estimate the network fee (block explorer unreachable): {e}. Try again."
        ))
    })?;
    let fee = sweep_fee(vsize, fee_rate);

    // Clamp the sent amount to what's actually left after the fee. A near-max
    // request (the UI prefills total minus a rough buffer) then sends
    // `selected - fee` with no change instead of failing when the real fee
    // exceeds that buffer; a genuine partial request is sent as-is, the rest as
    // change. Only a pool too small to cover fee + dust is a hard error.
    let max_sendable = selected
        .checked_sub(fee)
        .filter(|a| *a >= dust)
        .ok_or_else(|| {
            AppError::Wallet(format!(
                "Mature funds ({selected}) can't cover the network fee ({fee}) plus the dust \
                 minimum. Wait for more outputs to mature."
            ))
        })?;
    let to_amount = to_amount.min(max_sendable);

    let tx = build_sweep_tx(
        &to_address,
        to_amount,
        &change_address,
        fee,
        dust,
        &inputs,
        &sign,
    )?;

    let txid = tx.compute_txid();
    tokio::time::timeout(ctx.timeout, ctx.blockchain.broadcast(&tx))
        .await
        .map_err(|_| AppError::Wallet(format!("Timed out broadcasting sweep {txid}")))?
        .map_err(|e| AppError::Wallet(format!("Failed to broadcast sweep {txid}: {e}")))?;

    Ok(txid)
}

/// Sweep one or more unrolled VTXOs to a regular Bitcoin address (distinct
/// from `commands::send::send_onchain`, which is the *cooperative* offboard
/// path that doesn't pick up unrolled VTXOs).
///
/// Coin selection picks from boarding outputs + unrolled VTXOs; the resulting
/// tx spends them via their respective exit scripts (with the right CSV
/// sequence). If selected coins haven't matured past the CSV delay, Core
/// will accept the tx but it won't mine until the timelock elapses — so the
/// caller should ideally only sweep mature outputs.
///
/// Always builds the sweep itself (the SDK's `send_on_chain` reserves no fee and
/// broadcasts a 0-fee tx the relay rejects — "min relay fee not met"). When a
/// live client exists it supplies the authoritative VTXO set (covering every
/// address variant); otherwise the builder falls back to the recovery cache +
/// esplora + locally-derived keys, so the sweep still works with the ASP down —
/// the emergency-exit scenario the flow exists for.
#[tauri::command(rename_all = "camelCase")]
pub async fn sweep_unrolled_to_onchain(
    app: tauri::AppHandle,
    address: String,
    amount_sat: u64,
) -> Result<String, AppError> {
    let amount = super::send::validate_amount_sat(amount_sat)?;

    // wallet.json records the network at connect time, so address validation
    // works identically with or without a live ASP connection.
    let wallet_data = super::wallet::read_wallet_data(&app).await?;
    let network = wallet_data
        .network
        .parse::<bitcoin::Network>()
        .map_err(|e| AppError::Wallet(format!("Invalid network in wallet.json: {e}")))?;
    let btc_addr = super::send::parse_onchain_address(&address, network)?;

    let (client, key_provider) = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        match guard.as_ref() {
            Some(ws) => (
                Some(Arc::clone(&ws.client)),
                Some(Arc::clone(&ws.key_provider)),
            ),
            None => (None, None),
        }
    };

    info!(address = %address, amount_sat, connected = client.is_some(), "sweeping unrolled VTXOs to onchain");

    let txid = sweep_unrolled(&app, client, key_provider, btc_addr, amount).await?;

    info!(txid = %txid, "swept unrolled VTXOs");
    Ok(txid.to_string())
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

    #[test]
    fn sweep_fee_scales_with_rate_and_size() {
        // 150 vB at 10 sat/vB → 1500 sats.
        assert_eq!(sweep_fee(150, 10.0), bitcoin::Amount::from_sat(1500));
        // Rounds up to clear the relay minimum.
        assert_eq!(sweep_fee(150, 1.5), bitcoin::Amount::from_sat(225));
        assert_eq!(sweep_fee(151, 1.5), bitcoin::Amount::from_sat(227));
    }

    #[test]
    fn sweep_fee_floors_at_one_sat_per_vbyte() {
        // A degenerate/zero/sub-1 rate must never produce a below-relay fee:
        // floor at vsize (1 sat/vB) so the tx always clears "min relay fee not met".
        assert_eq!(sweep_fee(200, 0.0), bitcoin::Amount::from_sat(200));
        assert_eq!(sweep_fee(200, 0.5), bitcoin::Amount::from_sat(200));
        assert_eq!(sweep_fee(200, f64::NAN), bitcoin::Amount::from_sat(200));
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

    #[test]
    fn endpoint_requires_url_token_optional() {
        let with_token = endpoint_from_parts(Some("https://x".into()), Some("tok".into()))
            .expect("url + token is a full endpoint");
        assert_eq!(with_token.token.as_deref(), Some("tok"));

        let tokenless = endpoint_from_parts(Some("https://x".into()), None)
            .expect("url without token is a valid endpoint");
        assert_eq!(tokenless.token, None);
        let empty_token = endpoint_from_parts(Some("https://x".into()), Some("".into()))
            .expect("empty token means tokenless");
        assert_eq!(empty_token.token, None);

        assert!(endpoint_from_parts(None, Some("tok".into())).is_none());
        assert!(endpoint_from_parts(Some("".into()), Some("tok".into())).is_none());
    }

    #[test]
    fn default_endpoint_is_mainnet_only() {
        // The baked-in default fronts a mainnet Core node, so it must never be
        // handed to a test-network wallet — regardless of whether THIS build
        // compiled one in (option_env! is None under `cargo test`, but the
        // network gate holds either way).
        assert!(default_submitpackage_endpoint(bitcoin::Network::Signet).is_none());
        assert!(default_submitpackage_endpoint(bitcoin::Network::Testnet).is_none());
        assert!(default_submitpackage_endpoint(bitcoin::Network::Regtest).is_none());
    }

    #[test]
    fn submitpackage_success_is_ok() {
        let body = r#"{"result":{"package_msg":"success","tx-results":{"aa":{"txid":"bb"}}},"error":null,"id":1}"#;
        assert_eq!(check_submitpackage_response(body), Ok(()));
    }

    #[test]
    fn submitpackage_rpc_error_is_rejected() {
        let body = r#"{"result":null,"error":{"code":-25,"message":"package-not-child-with-parents"},"id":1}"#;
        let msg = check_submitpackage_response(body).unwrap_err();
        assert!(msg.contains("package-not-child-with-parents"), "{msg}");
    }

    #[test]
    fn submitpackage_policy_rejection_inside_result_is_rejected() {
        // v27+ shape: HTTP 200, error:null, rejection reported via package_msg
        // + per-tx errors. This is the one that used to be reported as success.
        let body = r#"{"result":{"package_msg":"transaction failed","tx-results":{"aa":{"txid":"bb","error":"min relay fee not met"}}},"error":null,"id":1}"#;
        let msg = check_submitpackage_response(body).unwrap_err();
        assert!(msg.contains("transaction failed"), "{msg}");
        assert!(msg.contains("min relay fee not met"), "{msg}");
    }

    #[test]
    fn submitpackage_bare_result_without_envelope_is_handled() {
        // A proxy may forward Core's result without the JSON-RPC envelope.
        let rejected = r#"{"package_msg":"transaction failed","tx-results":{}}"#;
        assert!(check_submitpackage_response(rejected).is_err());
        let ok = r#"{"package_msg":"success","tx-results":{}}"#;
        assert_eq!(check_submitpackage_response(ok), Ok(()));
    }

    #[test]
    fn submitpackage_invalid_json_is_rejected() {
        assert!(check_submitpackage_response("<html>502 Bad Gateway</html>").is_err());
    }

    #[test]
    fn exit_delay_time_based_resolves_to_seconds() {
        let seq = bitcoin::Sequence::from_512_second_intervals(7);
        assert_eq!(exit_delay_to_seconds(seq), Some(7 * 512));
    }

    #[test]
    fn exit_delay_block_based_is_unsupported() {
        let seq = bitcoin::Sequence::from_height(144);
        assert_eq!(exit_delay_to_seconds(seq), None);
    }

    #[test]
    fn exit_delay_seconds_roundtrips_through_sequence() {
        let seq = bitcoin::Sequence::from_512_second_intervals(7);
        let secs = exit_delay_to_seconds(seq).unwrap();
        assert_eq!(exit_delay_from_seconds(secs), Some(seq));
    }

    #[test]
    fn exit_delay_from_seconds_rejects_invalid_values() {
        // Not a multiple of 512 — can never have come from a time-based lock.
        assert_eq!(exit_delay_from_seconds(1000), None);
        // Interval count overflows the u16 sequence field.
        assert_eq!(exit_delay_from_seconds((u16::MAX as u64 + 1) * 512), None);
    }

    #[test]
    fn exit_delay_non_relative_locktime_is_unsupported() {
        // Disable flag set — not a valid relative locktime at all.
        assert_eq!(exit_delay_to_seconds(bitcoin::Sequence::MAX), None);
    }

    fn candidate(outpoint: &str, amount_sat: u64) -> CachedBranchSource {
        CachedBranchSource {
            outpoint: outpoint.to_string(),
            amount_sat,
        }
    }

    #[test]
    fn merge_sweep_candidates_dedupes_primary_wins() {
        let merged = merge_sweep_candidates(
            vec![candidate("aa:0", 1000), candidate("bb:1", 2000)],
            vec![candidate("bb:1", 9999), candidate("cc:0", 3000)],
        );
        let as_pairs: Vec<_> = merged
            .iter()
            .map(|c| (c.outpoint.as_str(), c.amount_sat))
            .collect();
        assert_eq!(
            as_pairs,
            vec![("aa:0", 1000), ("bb:1", 2000), ("cc:0", 3000)]
        );
    }

    #[test]
    fn merge_sweep_candidates_handles_empty_sides() {
        assert!(merge_sweep_candidates(vec![], vec![]).is_empty());
        let only_secondary = merge_sweep_candidates(vec![], vec![candidate("aa:0", 1)]);
        assert_eq!(only_secondary.len(), 1);
    }

    #[test]
    fn funding_blocker_none_with_confirmed_balance() {
        assert_eq!(onchain_funding_blocker(2610, 0), None);
        // Confirmed sats unblock regardless of what else is pending.
        assert_eq!(onchain_funding_blocker(2610, 500), None);
    }

    #[test]
    fn funding_blocker_asks_to_wait_when_change_is_pending() {
        // Post-broadcast state: the anchor child returned change that hasn't
        // confirmed yet. The user must wait, not deposit.
        let msg = onchain_funding_blocker(0, 2271).unwrap();
        assert!(msg.contains("2271 sats pending"), "got: {msg}");
        assert!(msg.contains("no new deposit"), "got: {msg}");
    }

    #[test]
    fn funding_blocker_asks_to_deposit_when_wallet_is_empty() {
        let msg = onchain_funding_blocker(0, 0).unwrap();
        assert!(msg.contains("send sats"), "got: {msg}");
    }
}
