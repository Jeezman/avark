//! LendaSwap persistence layer.
//!
//! Pre-2026-04-23 this module wrapped `lendaswap-core` to orchestrate quote +
//! create + claim against the LendaSwap backend from Rust. That architecture
//! is gone — the canonical SDK is now the TypeScript package
//! `@lendasat/lendaswap-sdk-pure`, called directly from the frontend. See
//! `tasks/prd-btc-stablecoin-swap.md` for the architectural note.
//!
//! What remains here is persistence-only: open `lendaswap.db`, run migrations,
//! expose a typed `SwapRecord` + small error enum so the frontend can mirror
//! SDK state into SQLite via `commands::lendaswap::{insert,update,get,list}`.
//! The Rust side no longer knows how to talk to LendaSwap; it just stores what
//! the TS SDK tells it about.

use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

pub(crate) struct LendaSwapDb(pub(crate) SqlitePool);

/// The set of `status` values considered terminal — no further server-side
/// transition is expected and polling/reconcile should stop.
///
/// **Mirrored in TS:** `TERMINAL_SWAP_STATUSES` in `src/lib/lendaswap/client.ts`
/// and the SQL `CHECK(status IN (…))` in the `lendaswap_swaps` table's
/// migration both list the same set. Three sources of truth — keep them in
/// sync until codegen exists.
pub(crate) const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "expired", "refunded"];

pub(crate) fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Open `lendaswap.db` (creating if missing), run migrations, return the pool.
pub(crate) async fn init(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    migrate(&pool).await?;
    info!(path = %path.display(), "lendaswap db ready");
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Storage rule for this table:
    //   * BTC amounts (sats) → INTEGER. Includes source_amount_sats, network_fee,
    //     protocol_fee, service_fee — all sat-denominated u64 from LendaSwap.
    //   * Stablecoin amounts → TEXT (Decimal). target_amount only, because
    //     USDC/USDT carry fractional units that don't fit in an INTEGER.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS lendaswap_swaps (
            id                  TEXT PRIMARY KEY NOT NULL,
            lendaswap_id        TEXT NOT NULL UNIQUE,
            direction           TEXT NOT NULL CHECK(direction IN ('btc_to_evm')),
            source_amount_sats  INTEGER NOT NULL,
            target_token        TEXT NOT NULL CHECK(target_token IN ('usdc_eth','usdt_eth')),
            target_amount       TEXT NOT NULL,
            destination_address TEXT NOT NULL,
            ln_invoice          TEXT NOT NULL,
            network_fee         INTEGER NOT NULL,
            protocol_fee        INTEGER NOT NULL,
            service_fee         INTEGER NOT NULL,
            status              TEXT NOT NULL CHECK(status IN (
                                    'pending','awaiting_payment','processing',
                                    'completed','failed','expired','refunded'
                                )),
            claim_tx_hash       TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL,
            completed_at        INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    rebuild_fee_columns_if_legacy(pool).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_lendaswap_swaps_status ON lendaswap_swaps(status)")
        .execute(pool)
        .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_lendaswap_swaps_created_at \
         ON lendaswap_swaps(created_at DESC)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_lendaswap_swaps_status_created_at \
         ON lendaswap_swaps(status, created_at DESC)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Migrate dev DBs created with the original schema where the three fee
/// columns were `TEXT`. Rebuilds the table in place with the INTEGER shape
/// and CASTs existing values across. Idempotent — the PRAGMA guard skips once
/// the new schema is in effect. Safe because the feature is pre-release and
/// the only rows present are dev test data.
async fn rebuild_fee_columns_if_legacy(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let fee_type: Option<String> = sqlx::query_scalar(
        "SELECT type FROM pragma_table_info('lendaswap_swaps') WHERE name = 'network_fee'",
    )
    .fetch_optional(pool)
    .await?;

    if !matches!(fee_type.as_deref(), Some("TEXT")) {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        CREATE TABLE lendaswap_swaps_v2 (
            id                  TEXT PRIMARY KEY NOT NULL,
            lendaswap_id        TEXT NOT NULL UNIQUE,
            direction           TEXT NOT NULL CHECK(direction IN ('btc_to_evm')),
            source_amount_sats  INTEGER NOT NULL,
            target_token        TEXT NOT NULL CHECK(target_token IN ('usdc_eth','usdt_eth')),
            target_amount       TEXT NOT NULL,
            destination_address TEXT NOT NULL,
            ln_invoice          TEXT NOT NULL,
            network_fee         INTEGER NOT NULL,
            protocol_fee        INTEGER NOT NULL,
            service_fee         INTEGER NOT NULL,
            status              TEXT NOT NULL CHECK(status IN (
                                    'pending','awaiting_payment','processing',
                                    'completed','failed','expired','refunded'
                                )),
            claim_tx_hash       TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL,
            completed_at        INTEGER
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO lendaswap_swaps_v2 (\
             id, lendaswap_id, direction, source_amount_sats, target_token, \
             target_amount, destination_address, ln_invoice, \
             network_fee, protocol_fee, service_fee, \
             status, claim_tx_hash, created_at, updated_at, completed_at\
         ) \
         SELECT \
             id, lendaswap_id, direction, source_amount_sats, target_token, \
             target_amount, destination_address, ln_invoice, \
             CAST(network_fee AS INTEGER), CAST(protocol_fee AS INTEGER), \
             CAST(service_fee AS INTEGER), \
             status, claim_tx_hash, created_at, updated_at, completed_at \
         FROM lendaswap_swaps",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query("DROP TABLE lendaswap_swaps")
        .execute(&mut *tx)
        .await?;
    sqlx::query("ALTER TABLE lendaswap_swaps_v2 RENAME TO lendaswap_swaps")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    info!("lendaswap_swaps fee columns rebuilt as INTEGER");
    Ok(())
}

/// The full `lendaswap_swaps` row as returned to the frontend. Field names
/// match the table columns 1:1.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub(crate) struct SwapRecord {
    pub id: String,
    pub lendaswap_id: String,
    pub direction: String,
    pub source_amount_sats: i64,
    pub target_token: String,
    pub target_amount: String,
    pub destination_address: String,
    pub ln_invoice: String,
    pub network_fee: i64,
    pub protocol_fee: i64,
    pub service_fee: i64,
    pub status: String,
    pub claim_tx_hash: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

/// Errors surfaced to the frontend from the DB-only Rust commands.
/// Tagged so the TS `formatLendaSwapError` can match on `kind`.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum LendaSwapError {
    #[error("database error: {message}")]
    Database { message: String },
    #[error("swap not found: {id}")]
    NotFound { id: String },
    #[error("wallet not initialized")]
    WalletNotInitialized,
    #[error("{message}")]
    Other { message: String },
}

impl From<sqlx::Error> for LendaSwapError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            // `fetch_one` on a missing id bubbles up RowNotFound; callers that
            // know the id supply it themselves rather than relying on this
            // unknown placeholder.
            sqlx::Error::RowNotFound => Self::NotFound {
                id: "(unknown)".into(),
            },
            other => Self::Database {
                message: other.to_string(),
            },
        }
    }
}
