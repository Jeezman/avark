use ark_client::SwapStorage as _;
use bitcoin::hashes::Hash as _;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tracing::{debug, info, warn};

use crate::{ark, AppError, GlobalWalletState};

pub(crate) const BOLTZ_URL: &str = "https://api.ark.boltz.exchange";

/// Update the local swap DB status by fetching the swap, changing its status field, and saving it back.
/// `status_str` should be a Boltz status string like "invoice.settled".
///
/// The SDK's `SwapStatus` enum is missing some Boltz statuses (e.g. `invoice.settled`).
/// When the exact status can't be deserialized, we fall back to the closest SDK-known
/// equivalent so the DB row still gets updated.
/// See: <https://github.com/arkade-os/rust-sdk/issues/185>
async fn sync_swap_status(
    storage: &ark_client::SqliteSwapStorage,
    swap_id: &str,
    status_str: &str,
) {
    if let Ok(Some(mut data)) = storage.get_reverse(swap_id).await {
        let new_status = serde_json::from_value(serde_json::Value::String(status_str.to_string()))
            .or_else(|_| {
                // Map unknown Boltz statuses to the closest SDK-known variant.
                let fallback = match status_str {
                    "invoice.settled" => "transaction.claimed",
                    _ => return Err(()),
                };
                serde_json::from_value(serde_json::Value::String(fallback.to_string()))
                    .map_err(|_| ())
            });
        if let Ok(new_status) = new_status {
            data.status = new_status;
            let _ = storage.update_reverse(swap_id, data).await;
        }
    }
}

// Thin Boltz status fallback — only needed because the SDK's `SwapStatus` enum
// is missing `invoice.settled` (upstream issue #185). Once fixed upstream, remove
// `check_boltz_status` and rely on `client.subscribe_to_swap_updates()` everywhere.

/// Shared HTTP client for Boltz status checks (avoids per-call construction).
fn boltz_http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client")
    })
}

/// Single raw status check against the Boltz API. Returns the status string
/// without going through the SDK's `SwapStatus` enum (which can't deserialize
/// `invoice.settled`).
async fn check_boltz_status(swap_id: &str) -> Result<String, AppError> {
    #[derive(Deserialize)]
    struct Resp {
        status: String,
    }

    let url = format!("{BOLTZ_URL}/v2/swap/{swap_id}");
    let resp: Resp = boltz_http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Wallet(format!("Boltz request failed: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Wallet(format!("Boltz API error: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to parse Boltz response: {e}")))?;
    Ok(resp.status)
}

fn is_claimable_status(status: &str) -> bool {
    matches!(status, "transaction.mempool" | "transaction.confirmed")
}

fn is_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "transaction.claimed"
            | "transaction.refunded"
            | "transaction.failed"
            | "invoice.expired"
            | "invoice.settled"
            | "swap.expired"
            | "invoice.failedToPay"
    )
}

/// Terminal statuses that indicate the swap completed successfully.
fn is_successful_terminal(status: &str) -> bool {
    matches!(status, "transaction.claimed" | "invoice.settled")
}

/// Search HD key indices to find and cache the claim key for a swap.
/// This is needed because the Bip32KeyProvider's index resets on app restart.
///
/// The key provider's index is shared with wallet receive-address derivation
/// (`get_offchain_address`), so the number of reverse swaps is *not* an upper
/// bound on which index a given claim key sits at — viewing the Receive screen
/// advances the counter without creating a swap. We search a generous range
/// since HD derivation is fast.
fn discover_swap_claim_key(
    key_provider: &ark_client::Bip32KeyProvider,
    claim_pk: &bitcoin::XOnlyPublicKey,
) -> Result<(), AppError> {
    use ark_client::KeyProvider;
    const MAX_DISCOVERY_INDEX: u32 = 50_000;
    for i in 0..MAX_DISCOVERY_INDEX {
        if let Some(kp) = key_provider
            .derive_at_discovery_index(i)
            .map_err(|e| AppError::Wallet(format!("Key derivation failed: {e}")))?
        {
            if &kp.x_only_public_key().0 == claim_pk {
                key_provider
                    .cache_discovered_keypair(i, kp)
                    .map_err(|e| AppError::Wallet(format!("Key cache failed: {e}")))?;
                debug!(index = i, "discovered swap claim key");
                return Ok(());
            }
        }
    }
    Err(AppError::Wallet(format!(
        "Public key {} not found in HD wallet. Searched indices 0..{MAX_DISCOVERY_INDEX}",
        claim_pk
    )))
}

#[derive(Clone, Serialize)]
pub(crate) struct PaymentReceived {
    pub(crate) amount_sat: u64,
}

/// Check for any pending reverse swaps in the database and attempt to claim them.
/// This handles the case where the app restarted while a claim was in progress.
pub(crate) fn spawn_pending_swap_recovery(
    client: Arc<ark::ArkClient>,
    swap_storage: Arc<ark_client::SqliteSwapStorage>,
    key_provider: Arc<ark_client::Bip32KeyProvider>,
    app: &tauri::AppHandle,
    cancel_rx: tokio::sync::watch::Receiver<()>,
) {
    let app = app.clone();
    tokio::spawn(async move {
        let pending = match swap_storage.list_all_reverse().await {
            Ok(swaps) => swaps,
            Err(e) => {
                warn!("failed to list reverse swaps for recovery: {e}");
                return;
            }
        };

        for swap in pending {
            // Check cancellation between each swap.
            if cancel_rx.has_changed().unwrap_or(true) {
                info!("wallet deleted, aborting swap recovery");
                return;
            }

            let swap_id = swap.id.clone();

            // Skip terminal statuses
            let status_str = serde_json::to_value(&swap.status)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            if is_terminal_status(&status_str) {
                continue;
            }

            let preimage = match swap.preimage {
                Some(p) => p,
                None => continue,
            };

            info!(swap_id = %swap_id, status = ?swap.status, "attempting recovery of pending reverse swap");

            // Check actual Boltz status first
            let boltz_status = match check_boltz_status(&swap_id).await {
                Ok(s) => s,
                Err(e) => {
                    debug!(swap_id = %swap_id, error = %e, "swap recovery: could not check Boltz status");
                    continue;
                }
            };

            // Already claimed — just sync local DB
            if is_successful_terminal(&boltz_status) {
                sync_swap_status(&swap_storage, &swap_id, &boltz_status).await;
                continue;
            }

            if !is_claimable_status(&boltz_status) {
                debug!(swap_id = %swap_id, boltz_status = %boltz_status, "swap recovery: not claimable");
                sync_swap_status(&swap_storage, &swap_id, &boltz_status).await;
                continue;
            }

            // Ensure the HD key provider can find the claim key for this swap.
            let claim_pk = swap.claim_public_key.inner.x_only_public_key().0;
            if let Err(e) = discover_swap_claim_key(&key_provider, &claim_pk) {
                warn!(swap_id = %swap_id, error = %e, "swap recovery: could not find claim key");
                continue;
            }

            match client.claim_vhtlc(&swap_id, preimage).await {
                Ok(claim) => {
                    info!(
                        swap_id = %swap_id,
                        amount_sat = claim.claim_amount.to_sat(),
                        "recovered pending swap successfully"
                    );
                    sync_swap_status(&swap_storage, &swap_id, "invoice.settled").await;
                    let _ = app.emit(
                        "payment-received",
                        PaymentReceived {
                            amount_sat: claim.claim_amount.to_sat(),
                        },
                    );
                }
                Err(e) => {
                    debug!(swap_id = %swap_id, error = %e, "swap recovery: claim failed");
                }
            }
        }
    });
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct SwapRecord {
    id: String,
    status: String,
    amount_sat: u64,
    has_preimage: bool,
    created_at: u64,
    is_terminal: bool,
    is_successful_terminal: bool,
}

#[tauri::command]
pub async fn get_ln_invoice(app: tauri::AppHandle, amount_sat: u64) -> Result<String, AppError> {
    let (client, swap_storage, mut cancel_rx) = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        (
            Arc::clone(&ws.client),
            Arc::clone(&ws.swap_storage),
            ws.wallet_cancel.subscribe(),
        )
    };

    if amount_sat == 0 {
        return Err(AppError::Wallet("Amount must be greater than zero".into()));
    }

    let amount = bitcoin::Amount::from_sat(amount_sat);
    let result = client
        .get_ln_invoice(ark_client::SwapAmount::invoice(amount), None)
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to create Lightning invoice: {e}")))?;

    let invoice_str = result.invoice.to_string();
    let swap_id = result.swap_id;

    let bg_client = Arc::clone(&client);
    let bg_app = app.clone();
    tokio::spawn(async move {
        info!(swap_id = %swap_id, "waiting for VHTLC funding");

        // Use the SDK's built-in polling. It errors on `invoice.settled` (missing
        // enum variant), so on error we do a single raw check to distinguish
        // "already complete" from a real failure.
        let funded = tokio::select! {
            biased;
            _ = cancel_rx.changed() => {
                info!(swap_id = %swap_id, "wallet deleted, aborting swap task");
                return;
            }
            result = bg_client.wait_for_vhtlc_funding(&swap_id) => result,
        };

        if let Err(sdk_err) = funded {
            // SDK can't deserialize invoice.settled — check if swap already succeeded.
            match check_boltz_status(&swap_id).await {
                Ok(status) if is_successful_terminal(&status) => {
                    info!(swap_id = %swap_id, status = %status, "swap already completed, skipping claim");
                    sync_swap_status(&swap_storage, &swap_id, &status).await;
                    return;
                }
                Ok(status) if is_terminal_status(&status) => {
                    warn!(swap_id = %swap_id, status = %status, "swap failed");
                    let _ =
                        bg_app.emit("ln-swap-error", format!("Lightning swap failed: {status}"));
                    return;
                }
                _ => {
                    warn!(swap_id = %swap_id, error = %sdk_err, "VHTLC funding wait failed");
                    let _ =
                        bg_app.emit("ln-swap-error", format!("Lightning swap failed: {sdk_err}"));
                    return;
                }
            }
        }

        // Check cancellation before claiming.
        if cancel_rx.has_changed().unwrap_or(true) {
            info!(swap_id = %swap_id, "wallet deleted, aborting swap task before claim");
            return;
        }

        info!(swap_id = %swap_id, "VHTLC funded, retrieving preimage and claiming");

        let preimage = match swap_storage.get_reverse(&swap_id).await {
            Ok(Some(data)) => match data.preimage {
                Some(p) => p,
                None => {
                    warn!(swap_id = %swap_id, "no preimage found in swap data");
                    let _ = bg_app.emit(
                        "ln-swap-error",
                        "Lightning swap failed: missing preimage".to_string(),
                    );
                    return;
                }
            },
            Ok(None) => {
                warn!(swap_id = %swap_id, "swap not found in storage");
                let _ = bg_app.emit(
                    "ln-swap-error",
                    "Lightning swap failed: swap not found".to_string(),
                );
                return;
            }
            Err(e) => {
                warn!(swap_id = %swap_id, error = %e, "failed to read swap storage");
                let _ = bg_app.emit("ln-swap-error", format!("Lightning swap failed: {e}"));
                return;
            }
        };

        match bg_client.claim_vhtlc(&swap_id, preimage).await {
            Ok(claim) => {
                info!(
                    swap_id = %swap_id,
                    txid = %claim.claim_txid,
                    amount_sat = claim.claim_amount.to_sat(),
                    "VHTLC claimed successfully"
                );
                sync_swap_status(&swap_storage, &swap_id, "invoice.settled").await;
                let _ = bg_app.emit(
                    "payment-received",
                    PaymentReceived {
                        amount_sat: claim.claim_amount.to_sat(),
                    },
                );
            }
            Err(e) => {
                warn!(swap_id = %swap_id, error = %e, "VHTLC claim failed");
                let _ = bg_app.emit("ln-swap-error", format!("Lightning claim failed: {e}"));
            }
        }
    });

    Ok(invoice_str)
}

#[tauri::command]
pub async fn debug_list_swaps(app: tauri::AppHandle) -> Result<Vec<SwapRecord>, AppError> {
    let swap_storage = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        Arc::clone(
            &guard
                .as_ref()
                .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?
                .swap_storage,
        )
    };

    let swaps = swap_storage
        .list_all_reverse()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to list swaps: {e}")))?;

    // Only poll Boltz for recent non-terminal swaps. Reverse swaps have a
    // ~24 h lifecycle; anything older is certainly expired. This caps the
    // number of network requests regardless of total swap history.
    const RECENT_WINDOW_SECS: u64 = 24 * 60 * 60;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut records = Vec::with_capacity(swaps.len());
    let mut pending: Vec<(usize, String)> = Vec::new();

    for s in &swaps {
        let local_status = serde_json::to_value(&s.status)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| format!("{:?}", s.status));

        let idx = records.len();
        records.push(SwapRecord {
            id: s.id.clone(),
            is_terminal: is_terminal_status(&local_status),
            is_successful_terminal: is_successful_terminal(&local_status),
            status: local_status.clone(),
            amount_sat: s.amount.to_sat(),
            has_preimage: s.preimage.is_some(),
            created_at: s.created_at,
        });

        if !is_terminal_status(&local_status)
            && now.saturating_sub(s.created_at) < RECENT_WINDOW_SECS
        {
            pending.push((idx, s.id.clone()));
        }
    }

    // Check recent non-terminal swap statuses in parallel (bounded by the 24 h window).
    if !pending.is_empty() {
        let mut set = tokio::task::JoinSet::new();
        for (idx, swap_id) in &pending {
            let id = swap_id.clone();
            let i = *idx;
            set.spawn(async move {
                let result = check_boltz_status(&id).await;
                (i, id, result)
            });
        }

        while let Some(Ok((idx, swap_id, result))) = set.join_next().await {
            if let Ok(boltz_status) = result {
                sync_swap_status(&swap_storage, &swap_id, &boltz_status).await;
                records[idx].is_terminal = is_terminal_status(&boltz_status);
                records[idx].is_successful_terminal = is_successful_terminal(&boltz_status);
                records[idx].status = boltz_status;
            }
        }
    }

    Ok(records)
}

#[tauri::command]
pub async fn retry_claim_swap(app: tauri::AppHandle, swap_id: String) -> Result<String, AppError> {
    let _ = app.emit("ln-swap-progress", format!("[{swap_id}] Starting claim..."));

    let (client, swap_storage, key_provider) = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        (
            Arc::clone(&ws.client),
            Arc::clone(&ws.swap_storage),
            Arc::clone(&ws.key_provider),
        )
    };

    let _ = app.emit(
        "ln-swap-progress",
        format!("[{swap_id}] Reading swap data..."),
    );
    let data = swap_storage
        .get_reverse(&swap_id)
        .await
        .map_err(|e| AppError::Wallet(format!("Storage read failed: {e}")))?
        .ok_or_else(|| AppError::Wallet("Swap not found in storage".into()))?;
    let claim_pk = data.claim_public_key.inner.x_only_public_key().0;

    let _ = app.emit(
        "ln-swap-progress",
        format!("[{swap_id}] Discovering claim key..."),
    );
    discover_swap_claim_key(&key_provider, &claim_pk)?;

    let _ = app.emit(
        "ln-swap-progress",
        format!("[{swap_id}] Checking Boltz funding status..."),
    );
    let boltz_status = check_boltz_status(&swap_id).await?;
    let _ = app.emit(
        "ln-swap-progress",
        format!("[{swap_id}] Boltz status: {boltz_status}"),
    );

    if is_successful_terminal(&boltz_status) {
        sync_swap_status(&swap_storage, &swap_id, &boltz_status).await;
        return Ok("Swap already claimed".into());
    }

    if !is_claimable_status(&boltz_status) {
        sync_swap_status(&swap_storage, &swap_id, &boltz_status).await;
        return Err(AppError::Wallet(format!(
            "Swap not claimable (status: {boltz_status})"
        )));
    }

    let preimage = data
        .preimage
        .ok_or_else(|| AppError::Wallet("No preimage found".into()))?;

    let _ = app.emit("ln-swap-progress", format!("[{swap_id}] Claiming VHTLC..."));
    let claim = client
        .claim_vhtlc(&swap_id, preimage)
        .await
        .map_err(|e| AppError::Wallet(format!("Claim failed: {e}")))?;

    sync_swap_status(&swap_storage, &swap_id, "invoice.settled").await;

    let msg = format!(
        "Claimed {} sats (txid: {})",
        claim.claim_amount.to_sat(),
        claim.claim_txid
    );
    info!(swap_id = %swap_id, "{msg}");

    let _ = app.emit(
        "payment-received",
        PaymentReceived {
            amount_sat: claim.claim_amount.to_sat(),
        },
    );

    Ok(msg)
}

// ── Submarine-swap recovery ─────────────────────────────────────────────────
//
// Submarine swaps (send path) lock sats into a VHTLC while Boltz routes the
// Lightning payment. If `pay_ln_invoice` returns but `wait_for_invoice_paid`
// is interrupted (app kill, network blip, tauri_spawn cancellation), the
// swap is orphaned in avark's UI even though the VHTLC is perfectly fine.
//
// These commands expose the stored submarine swaps so users can see what's
// stuck and refund if Boltz is never going to route the payment.

/// Boltz statuses where the VHTLC still holds funds AND a refund is allowed.
/// Cooperative refund (`refund_vhtlc`) works for the non-expired variants;
/// `swap.expired` requires the unilateral `refund_expired_vhtlc` path.
fn is_refundable_boltz_status(status: &str) -> bool {
    matches!(
        status,
        "transaction.failed" | "invoice.failedToPay" | "invoice.expired" | "swap.expired"
    )
}

fn needs_unilateral_refund(status: &str) -> bool {
    status == "swap.expired"
}

#[derive(Serialize)]
pub struct SubmarineSwapRecord {
    pub id: String,
    pub amount_sat: u64,
    /// BOLT11 payment hash in hex. Truncated display is a UI concern.
    pub payment_hash: String,
    pub created_at: u64,
    /// avark's locally-cached Boltz status (may be stale).
    pub local_status: String,
    /// Freshly-fetched Boltz status, or `None` if the API was unreachable.
    pub boltz_status: Option<String>,
    pub is_terminal: bool,
    pub is_successful_terminal: bool,
    /// True when the funds are still locked AND a refund path is available.
    pub is_refundable: bool,
    /// True when the timelock has expired — refund goes via the unilateral
    /// path (`refund_submarine_swap` dispatches automatically).
    pub is_expired_timelock: bool,
}

#[tauri::command]
pub async fn list_pending_submarine_swaps(
    app: tauri::AppHandle,
) -> Result<Vec<SubmarineSwapRecord>, AppError> {
    let swap_storage = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        Arc::clone(
            &guard
                .as_ref()
                .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?
                .swap_storage,
        )
    };

    let swaps = swap_storage
        .list_all_submarine()
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to list swaps: {e}")))?;

    // Submarine swaps have a ~24h timelock on Boltz. Fetch fresh status for
    // anything within a 48h window — older swaps are certainly terminal and
    // not worth an API round-trip. Sort newest-first so the UI can render
    // the most relevant (usually just-attempted) swap at the top.
    const RECENT_WINDOW_SECS: u64 = 48 * 60 * 60;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut records = Vec::with_capacity(swaps.len());
    let mut pending: Vec<(usize, String)> = Vec::new();

    for s in &swaps {
        let local_status = serde_json::to_value(&s.status)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| format!("{:?}", s.status));

        let idx = records.len();
        records.push(SubmarineSwapRecord {
            id: s.id.clone(),
            amount_sat: s.amount.to_sat(),
            payment_hash: hex::encode(s.preimage_hash.to_byte_array()),
            created_at: s.created_at,
            local_status: local_status.clone(),
            boltz_status: None,
            is_terminal: is_terminal_status(&local_status),
            is_successful_terminal: is_successful_terminal(&local_status),
            is_refundable: is_refundable_boltz_status(&local_status),
            is_expired_timelock: needs_unilateral_refund(&local_status),
        });

        if now.saturating_sub(s.created_at) < RECENT_WINDOW_SECS {
            pending.push((idx, s.id.clone()));
        }
    }

    // Refresh Boltz status for in-window swaps in parallel.
    if !pending.is_empty() {
        let mut set = tokio::task::JoinSet::new();
        for (idx, swap_id) in &pending {
            let id = swap_id.clone();
            let i = *idx;
            set.spawn(async move {
                let result = check_boltz_status(&id).await;
                (i, result)
            });
        }

        while let Some(Ok((idx, result))) = set.join_next().await {
            if let Ok(boltz_status) = result {
                records[idx].boltz_status = Some(boltz_status.clone());
                records[idx].is_terminal = is_terminal_status(&boltz_status);
                records[idx].is_successful_terminal = is_successful_terminal(&boltz_status);
                records[idx].is_refundable = is_refundable_boltz_status(&boltz_status);
                records[idx].is_expired_timelock = needs_unilateral_refund(&boltz_status);
            }
        }
    }

    // Newest first. The user's "just now stuck" swap should be at the top.
    records.sort_by_key(|r| std::cmp::Reverse(r.created_at));

    Ok(records)
}

#[tauri::command]
pub async fn refund_submarine_swap(
    app: tauri::AppHandle,
    swap_id: String,
) -> Result<String, AppError> {
    let (client, swap_storage) = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        (Arc::clone(&ws.client), Arc::clone(&ws.swap_storage))
    };

    // Fetch the freshest Boltz status so we pick the right refund path.
    // If Boltz is unreachable we can't safely call cooperative refund, but
    // we can still offer the unilateral path if the user knows the timelock
    // has passed — kept simple for now, require a live status.
    let boltz_status = check_boltz_status(&swap_id).await.map_err(|e| {
        AppError::Wallet(format!(
            "Couldn't reach Boltz to confirm the swap's current state: {e}"
        ))
    })?;

    if !is_refundable_boltz_status(&boltz_status) {
        return Err(AppError::Wallet(format!(
            "Swap is not refundable yet (Boltz status: {boltz_status}). \
             If it's still routing, wait — the checkout screen will update \
             automatically once it settles."
        )));
    }

    info!(swap_id = %swap_id, status = %boltz_status, "refunding submarine swap");
    let _ = app.emit(
        "ln-swap-progress",
        format!("[{swap_id}] Refunding via Boltz (status: {boltz_status})..."),
    );

    let txid = if needs_unilateral_refund(&boltz_status) {
        // Timelock expired — no Boltz signature needed.
        client
            .refund_expired_vhtlc(&swap_id)
            .await
            .map_err(|e| AppError::Wallet(format!("Unilateral refund failed: {e}")))?
    } else {
        // Cooperative refund — Boltz co-signs. Much faster than waiting for
        // the timelock since the swap failed and Boltz knows it.
        client
            .refund_vhtlc(&swap_id)
            .await
            .map_err(|e| AppError::Wallet(format!("Cooperative refund failed: {e}")))?
    };

    info!(swap_id = %swap_id, refund_txid = %txid, "submarine swap refunded");

    // Our refund tx is on-chain — mark the swap as refunded locally so the
    // recovery UI doesn't keep offering the refund button while Boltz's
    // status lags behind. `sync_swap_status_submarine` short-circuits on a
    // parse failure; the log is purely diagnostic.
    sync_swap_status_submarine(&swap_storage, &swap_id, "transaction.refunded").await;

    Ok(txid.to_string())
}

/// Mirror of `sync_swap_status` for submarine swaps. The SDK's `SwapStatus`
/// enum is not re-exported from `ark_client`'s root, but we can lean on
/// type inference via `SubmarineSwapData::status` to deserialize into it
/// without ever having to name the enum directly.
async fn sync_swap_status_submarine(
    storage: &ark_client::SqliteSwapStorage,
    swap_id: &str,
    status_str: &str,
) {
    let mut data = match storage.get_submarine(swap_id).await {
        Ok(Some(d)) => d,
        Ok(None) => {
            warn!(swap_id = %swap_id, "submarine swap not found in storage");
            return;
        }
        Err(e) => {
            warn!(
                swap_id = %swap_id,
                error = %e,
                "failed to read submarine swap before status sync"
            );
            return;
        }
    };
    // `data.status: SwapStatus` drives the deserializer's type inference.
    match serde_json::from_value(serde_json::Value::String(status_str.to_string())) {
        Ok(new_status) => {
            data.status = new_status;
            if let Err(e) = storage.update_status_submarine(swap_id, data.status).await {
                warn!(
                    swap_id = %swap_id,
                    error = %e,
                    "failed to update submarine swap status locally"
                );
            }
        }
        Err(e) => {
            warn!(
                swap_id = %swap_id,
                status = %status_str,
                error = %e,
                "could not deserialize Boltz status into SwapStatus enum"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_claimable_status ─────────────────────────────────────────────

    #[test]
    fn claimable_statuses() {
        assert!(is_claimable_status("transaction.mempool"));
        assert!(is_claimable_status("transaction.confirmed"));
    }

    #[test]
    fn non_claimable_statuses() {
        assert!(!is_claimable_status("transaction.claimed"));
        assert!(!is_claimable_status("invoice.settled"));
        assert!(!is_claimable_status("swap.expired"));
        assert!(!is_claimable_status(""));
        assert!(!is_claimable_status("unknown"));
    }

    // ── is_terminal_status ──────────────────────────────────────────────

    #[test]
    fn terminal_statuses() {
        for status in [
            "transaction.claimed",
            "transaction.refunded",
            "transaction.failed",
            "invoice.expired",
            "invoice.settled",
            "swap.expired",
            "invoice.failedToPay",
        ] {
            assert!(is_terminal_status(status), "{status} should be terminal");
        }
    }

    #[test]
    fn non_terminal_statuses() {
        for status in [
            "transaction.mempool",
            "transaction.confirmed",
            "invoice.pending",
            "swap.created",
            "",
            "unknown",
        ] {
            assert!(
                !is_terminal_status(status),
                "{status} should not be terminal"
            );
        }
    }

    // ── is_successful_terminal ──────────────────────────────────────────

    #[test]
    fn successful_terminal_statuses() {
        assert!(is_successful_terminal("transaction.claimed"));
        assert!(is_successful_terminal("invoice.settled"));
    }

    #[test]
    fn unsuccessful_terminal_statuses() {
        assert!(!is_successful_terminal("transaction.refunded"));
        assert!(!is_successful_terminal("transaction.failed"));
        assert!(!is_successful_terminal("swap.expired"));
        assert!(!is_successful_terminal("invoice.expired"));
        assert!(!is_successful_terminal("invoice.failedToPay"));
    }

    #[test]
    fn successful_terminal_is_subset_of_terminal() {
        for status in ["transaction.claimed", "invoice.settled"] {
            assert!(
                is_terminal_status(status),
                "successful terminal status {status} must also be terminal"
            );
        }
    }

    // ── is_refundable_boltz_status ──────────────────────────────────────

    #[test]
    fn refundable_statuses() {
        for status in [
            "transaction.failed",
            "invoice.failedToPay",
            "invoice.expired",
            "swap.expired",
        ] {
            assert!(
                is_refundable_boltz_status(status),
                "{status} should be refundable"
            );
        }
    }

    #[test]
    fn non_refundable_statuses() {
        // Successful terminals — funds went to Boltz as intended.
        assert!(!is_refundable_boltz_status("transaction.claimed"));
        assert!(!is_refundable_boltz_status("invoice.settled"));
        // Already refunded — nothing left to refund.
        assert!(!is_refundable_boltz_status("transaction.refunded"));
        // In-flight — still routing, may still succeed.
        assert!(!is_refundable_boltz_status("transaction.mempool"));
        assert!(!is_refundable_boltz_status("invoice.pending"));
        assert!(!is_refundable_boltz_status("swap.created"));
    }

    #[test]
    fn unilateral_refund_only_on_timelock_expiry() {
        assert!(needs_unilateral_refund("swap.expired"));
        // Cooperative-refundable states should not need unilateral.
        assert!(!needs_unilateral_refund("transaction.failed"));
        assert!(!needs_unilateral_refund("invoice.failedToPay"));
        assert!(!needs_unilateral_refund("invoice.expired"));
    }
}
