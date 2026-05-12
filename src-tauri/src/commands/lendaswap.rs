//! DB-only Tauri commands for mirroring TS-SDK swap state into avark's
//! `lendaswap.db`. The TS SDK (`@lendasat/lendaswap-sdk-pure`) is the source
//! of truth for all LendaSwap network operations — these commands exist only
//! to persist the user-facing swap records for history + resume-after-restart.
//!
//!
//! Surface:
//!   * `insert_lendaswap_swap` — frontend calls after TS SDK creates a swap
//!   * `update_lendaswap_swap_status` — frontend calls after polling / WS update
//!   * `get_lendaswap_swap` — plain DB read (no remote refresh)
//!   * `list_lendaswap_swaps` — paginated history query
//!   * `get_lendaswap_xprv` — derives a LendaSwap-purpose xprv from the
//!                            wallet's mnemonic and hands only that to the
//!                            WebView.

use bitcoin::bip32::DerivationPath;
use bitcoin::Network;
use serde::Deserialize;
use zeroize::Zeroize;

use crate::lendaswap::{unix_now, LendaSwapDb, LendaSwapError, SwapRecord};
use crate::secure_storage::SecureStorage;

/// BIP-32 derivation path used as the master for the TS SDK's `Signer`.
///
/// Rationale:
///   * The SDK's `Client.builder().withXprv(...)` is documented as **never**
///     persisted to storage. Handing it a purpose-derived xprv keeps the root
///     mnemonic Rust-only and limits a WebView compromise to keys under this
///     subtree (LendaSwap HTLC preimages + per-swap signing keys + a Permit2
///     EVM key bound to this purpose path — not the user's main BTC funds).
///
/// `887'` is unused by the standard BIP registry (BIPs 32, 43, 44, 49, 84,
/// 86, 87…) so it doesn't collide with any wallet derivation a recovery tool
/// would attempt. The trailing `0'` is a keyspace generation: bump to `1'`,
/// `2'`, … to invalidate the LendaSwap subtree without rotating the user's
/// mnemonic, should that ever be needed.
const LENDASWAP_PURPOSE_PATH: &str = "m/887'/0'";

/// Payload from the TS SDK after it successfully creates a swap via
/// `client.createSwap(...)`. The frontend serialises the relevant fields from
/// the SDK response (plus its own user-facing UUID) and hands them here for
/// persistence.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InsertSwapParams {
    /// Our local user-facing id (frontend generates via `crypto.randomUUID()`
    /// so the persisted row's id matches whatever the router/URLs use).
    pub id: String,
    pub lendaswap_id: String,
    pub source_amount_sats: i64,
    pub target_token: String,
    pub target_amount: String,
    pub destination_address: String,
    pub ln_invoice: String,
    pub network_fee: i64,
    pub protocol_fee: i64,
    pub service_fee: i64,
    /// Canonical status from the SDK's initial response. We don't constrain
    /// it here — the CHECK constraint on the column rejects garbage and
    /// bubbles up as a Database error.
    pub status: String,
}

#[tauri::command]
pub(crate) async fn insert_lendaswap_swap(
    db: tauri::State<'_, LendaSwapDb>,
    params: InsertSwapParams,
) -> Result<SwapRecord, LendaSwapError> {
    let now = unix_now() as i64;
    sqlx::query(
        "INSERT INTO lendaswap_swaps (
            id, lendaswap_id, direction, source_amount_sats, target_token,
            target_amount, destination_address, ln_invoice,
            network_fee, protocol_fee, service_fee,
            status, created_at, updated_at
        ) VALUES (
            ?1, ?2, 'btc_to_evm', ?3, ?4,
            ?5, ?6, ?7,
            ?8, ?9, ?10,
            ?11, ?12, ?12
        )",
    )
    .bind(&params.id)
    .bind(&params.lendaswap_id)
    .bind(params.source_amount_sats)
    .bind(&params.target_token)
    .bind(&params.target_amount)
    .bind(&params.destination_address)
    .bind(&params.ln_invoice)
    .bind(params.network_fee)
    .bind(params.protocol_fee)
    .bind(params.service_fee)
    .bind(&params.status)
    .bind(now)
    .execute(&db.0)
    .await?;

    fetch_swap(&db.0, &params.id).await
}

/// Frontend passes the new status (and optional claim tx hash) after it
/// polls or receives a WebSocket event from the SDK. If the status is
/// terminal, `completed_at` is set to now automatically.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSwapStatusParams {
    pub id: String,
    pub status: String,
    pub claim_tx_hash: Option<String>,
}

#[tauri::command]
pub(crate) async fn update_lendaswap_swap_status(
    db: tauri::State<'_, LendaSwapDb>,
    params: UpdateSwapStatusParams,
) -> Result<SwapRecord, LendaSwapError> {
    let now = unix_now() as i64;
    let completed_at = if crate::lendaswap::is_terminal(&params.status) {
        Some(now)
    } else {
        None
    };

    let result = sqlx::query(
        "UPDATE lendaswap_swaps
         SET status = ?1,
             claim_tx_hash = COALESCE(?2, claim_tx_hash),
             updated_at = ?3,
             completed_at = COALESCE(?4, completed_at)
         WHERE id = ?5",
    )
    .bind(&params.status)
    .bind(params.claim_tx_hash.as_deref())
    .bind(now)
    .bind(completed_at)
    .bind(&params.id)
    .execute(&db.0)
    .await?;

    if result.rows_affected() == 0 {
        return Err(LendaSwapError::NotFound {
            id: params.id.clone(),
        });
    }

    fetch_swap(&db.0, &params.id).await
}

/// Minimum age before `dismiss_lendaswap_swap` will act. The LN invoice →
/// Boltz submarine swap → LendaSwap LN node flow typically completes within
/// a minute; 10 minutes is a conservative floor that ensures an in-flight
/// payment isn't cut off prematurely by a user hitting the dismiss button too
/// eagerly. Enforced on the Rust side so the UI's age gate isn't the only one.
const DISMISS_MIN_AGE_SECS: i64 = 10 * 60;

/// Locally mark a swap as `expired` when LendaSwap's server-side expiry is
/// lagging. This is a one-way "stop tracking" for swaps that avark has
/// refunded Boltz-side but LendaSwap still thinks are awaiting payment.
/// No LendaSwap API call — purely local record keeping so the reconciler
/// and history views move on.
#[tauri::command]
pub(crate) async fn dismiss_lendaswap_swap(
    db: tauri::State<'_, LendaSwapDb>,
    id: String,
) -> Result<SwapRecord, LendaSwapError> {
    let row = fetch_swap(&db.0, &id).await?;

    // Only `awaiting_payment` swaps are candidates. `pending` is an initial
    // pre-invoice state we don't expose to the user as dismissable; anything
    // past awaiting_payment is either mid-flight or already terminal and
    // must not be force-terminated here.
    if row.status != "awaiting_payment" {
        return Err(LendaSwapError::Other {
            message: format!(
                "Swap is in state `{}` — only `awaiting_payment` swaps can be dismissed. \
                 If it has progressed, let it run its course.",
                row.status
            ),
        });
    }

    let now = unix_now() as i64;
    let age = now - row.created_at;
    if age < DISMISS_MIN_AGE_SECS {
        let mins_to_wait = ((DISMISS_MIN_AGE_SECS - age) + 59) / 60;
        return Err(LendaSwapError::Other {
            message: format!(
                "Swap is too young to dismiss — wait {mins_to_wait} more minute(s) \
                 in case the Lightning payment is still routing."
            ),
        });
    }

    let result = sqlx::query(
        "UPDATE lendaswap_swaps
         SET status = 'expired',
             updated_at = ?1,
             completed_at = COALESCE(completed_at, ?1)
         WHERE id = ?2",
    )
    .bind(now)
    .bind(&id)
    .execute(&db.0)
    .await?;

    if result.rows_affected() == 0 {
        return Err(LendaSwapError::NotFound { id });
    }

    fetch_swap(&db.0, &id).await
}

/// Plain DB read — no remote refresh. The TS SDK handles freshness; this just
/// returns the last known state Rust has on file.
#[tauri::command]
pub(crate) async fn get_lendaswap_swap(
    db: tauri::State<'_, LendaSwapDb>,
    id: String,
) -> Result<SwapRecord, LendaSwapError> {
    let row = fetch_swap(&db.0, &id).await;
    if matches!(row, Err(LendaSwapError::NotFound { .. })) {
        // Replace the placeholder id in the From<sqlx::Error> impl with the
        // real one the caller supplied.
        return Err(LendaSwapError::NotFound { id });
    }
    row
}

/// Paginated list of swap records, newest first. `limit` is clamped to a hard
/// cap so a buggy caller can't load the whole table at once. Optional status
/// filter narrows to a single canonical state.
#[tauri::command]
pub(crate) async fn list_lendaswap_swaps(
    db: tauri::State<'_, LendaSwapDb>,
    limit: i64,
    offset: i64,
    status: Option<String>,
) -> Result<Vec<SwapRecord>, LendaSwapError> {
    const MAX_LIMIT: i64 = 100;
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(LendaSwapError::Other {
            message: format!("limit must be between 1 and {MAX_LIMIT} (got {limit})"),
        });
    }
    if offset < 0 {
        return Err(LendaSwapError::Other {
            message: format!("offset must be >= 0 (got {offset})"),
        });
    }

    let rows = match status {
        Some(s) => {
            sqlx::query_as::<_, SwapRecord>(
                "SELECT * FROM lendaswap_swaps \
                 WHERE status = ?1 \
                 ORDER BY created_at DESC \
                 LIMIT ?2 OFFSET ?3",
            )
            .bind(s)
            .bind(limit)
            .bind(offset)
            .fetch_all(&db.0)
            .await?
        }
        None => {
            sqlx::query_as::<_, SwapRecord>(
                "SELECT * FROM lendaswap_swaps \
                 ORDER BY created_at DESC \
                 LIMIT ?1 OFFSET ?2",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(&db.0)
            .await?
        }
    };
    Ok(rows)
}

/// Derive a LendaSwap-purpose extended private key from the wallet's mnemonic
/// and return it serialized (base58check). The frontend hands this to the
/// SDK's `Client.builder().withXprv(...)`, which per the SDK docs is **never**
/// persisted to IndexedDB — so the secret only lives in WebView memory for
/// the session.
///
/// Keeps the BIP39 mnemonic Rust-only: a WebView compromise (npm supply
/// chain, IDB exfil, dev tools) can drain LendaSwap-purpose keys but not the
/// user's main BTC funds. See `LENDASWAP_PURPOSE_PATH` for the derivation
/// rationale.
#[tauri::command]
pub(crate) async fn get_lendaswap_xprv(app: tauri::AppHandle) -> Result<String, LendaSwapError> {
    let store = SecureStorage::get_instance(&app);
    let mut words =
        crate::load_mnemonic(store).map_err(|_| LendaSwapError::WalletNotInitialized)?;
    let secret = crate::wallet::parse_mnemonic(&words).map_err(|e| LendaSwapError::Other {
        message: format!("invalid stored mnemonic: {e}"),
    })?;
    // `load_mnemonic` returns a plain String — zero the backing buffer once
    // we've parsed it into a zeroizing SecretMnemonic.
    words.zeroize();

    let path: DerivationPath = LENDASWAP_PURPOSE_PATH
        .parse()
        .expect("LENDASWAP_PURPOSE_PATH is a valid BIP-32 path");
    let xpriv = crate::wallet::derive_xpriv(&secret, Network::Bitcoin, &path).map_err(|e| {
        LendaSwapError::Other {
            message: format!("xpriv derivation failed: {e}"),
        }
    })?;
    Ok(xpriv.to_string())
}

async fn fetch_swap(pool: &sqlx::SqlitePool, id: &str) -> Result<SwapRecord, LendaSwapError> {
    sqlx::query_as::<_, SwapRecord>("SELECT * FROM lendaswap_swaps WHERE id = ?1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}
