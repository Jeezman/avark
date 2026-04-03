use ark_core::server::VirtualTxOutPoint;
use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;
use tracing::info;

use crate::{ark, AppError, GlobalWalletState};

fn parse_outpoints(outpoints: &[String]) -> Result<Vec<bitcoin::OutPoint>, AppError> {
    outpoints
        .iter()
        .map(|s| {
            s.parse::<bitcoin::OutPoint>()
                .map_err(|e| AppError::Wallet(format!("invalid outpoint \"{s}\": {e}")))
        })
        .collect()
}

async fn client(app: &tauri::AppHandle) -> Result<Arc<ark::ArkClient>, AppError> {
    let state = app.state::<GlobalWalletState>();
    let guard = state.0.read().await;
    let ws = guard
        .as_ref()
        .ok_or_else(|| AppError::Wallet("wallet not connected".into()))?;
    Ok(Arc::clone(&ws.client))
}

#[derive(Debug, Serialize)]
pub struct VtxoInfo {
    pub txid: String,
    pub vout: u32,
    pub amount_sat: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub status: VtxoStatus,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum VtxoStatus {
    Confirmed,
    PreConfirmed,
    Recoverable,
}

#[derive(Debug, Serialize)]
pub struct VtxoListResponse {
    pub vtxos: Vec<VtxoInfo>,
}

fn collect_vtxos<'a>(
    iter: impl Iterator<Item = &'a VirtualTxOutPoint>,
    status: VtxoStatus,
) -> Vec<VtxoInfo> {
    iter.map(|v| VtxoInfo {
        txid: v.outpoint.txid.to_string(),
        vout: v.outpoint.vout,
        amount_sat: v.amount.to_sat(),
        created_at: v.created_at,
        expires_at: v.expires_at,
        status,
    })
    .collect()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_vtxos(app: tauri::AppHandle) -> Result<VtxoListResponse, AppError> {
    let c = client(&app).await?;

    let (vtxo_list, _scripts) = c
        .list_vtxos()
        .await
        .map_err(|e| AppError::Wallet(format!("failed to list vtxos: {e}")))?;

    let mut vtxos = Vec::new();
    vtxos.extend(collect_vtxos(vtxo_list.confirmed(), VtxoStatus::Confirmed));
    vtxos.extend(collect_vtxos(
        vtxo_list.pre_confirmed(),
        VtxoStatus::PreConfirmed,
    ));
    vtxos.extend(collect_vtxos(
        vtxo_list.recoverable(),
        VtxoStatus::Recoverable,
    ));

    // Sort by expiry (soonest first)
    vtxos.sort_by_key(|v| v.expires_at);

    Ok(VtxoListResponse { vtxos })
}

#[derive(Debug, Serialize)]
pub struct FeeEstimate {
    pub fee_sat: i64,
}

/// Each element is "txid:vout", parsed into an OutPoint.
#[tauri::command(rename_all = "camelCase")]
pub async fn estimate_renew_fees(
    app: tauri::AppHandle,
    outpoints: Vec<String>,
) -> Result<FeeEstimate, AppError> {
    let vtxo_outpoints = parse_outpoints(&outpoints)?;

    let c = client(&app).await?;

    let address = c
        .get_offchain_address()
        .map_err(|e| AppError::Wallet(format!("failed to get address: {e}")))?
        .0;

    let mut rng = rand::rngs::OsRng;
    let fee = c
        .estimate_batch_fees_vtxo_selection(&mut rng, vtxo_outpoints.into_iter(), address)
        .await
        .map_err(|e| AppError::Wallet(format!("failed to estimate fees: {e}")))?;

    Ok(FeeEstimate {
        fee_sat: fee.to_sat(),
    })
}

#[derive(Debug, Serialize)]
pub struct RenewResult {
    pub renewed: bool,
    pub txid: Option<String>,
}

/// Each element is "txid:vout", parsed into an OutPoint.
#[tauri::command(rename_all = "camelCase")]
pub async fn renew_vtxos(
    app: tauri::AppHandle,
    outpoints: Vec<String>,
) -> Result<RenewResult, AppError> {
    info!(count = outpoints.len(), "renewing vtxos via settle");

    let vtxo_outpoints = parse_outpoints(&outpoints)?;

    if vtxo_outpoints.is_empty() {
        return Ok(RenewResult {
            renewed: false,
            txid: None,
        });
    }

    let c = client(&app).await?;

    let mut rng = rand::rngs::OsRng;
    let txid = c
        .settle_vtxos(&mut rng, &vtxo_outpoints, &[])
        .await
        .map_err(|e| AppError::Wallet(format!("failed to renew vtxos: {e}")))?;

    match txid {
        Some(id) => {
            info!(txid = %id, "vtxos renewed");
            Ok(RenewResult {
                renewed: true,
                txid: Some(id.to_string()),
            })
        }
        None => Ok(RenewResult {
            renewed: false,
            txid: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::{Amount, OutPoint, ScriptBuf, Txid};
    use std::str::FromStr;

    fn make_vtxo(
        txid_hex: &str,
        vout: u32,
        sats: u64,
        created: i64,
        expires: i64,
    ) -> VirtualTxOutPoint {
        VirtualTxOutPoint {
            outpoint: OutPoint {
                txid: Txid::from_str(txid_hex).unwrap(),
                vout,
            },
            script: ScriptBuf::new(),
            expires_at: expires,
            created_at: created,
            amount: Amount::from_sat(sats),
            is_preconfirmed: false,
            is_swept: false,
            is_unrolled: false,
            is_spent: false,
            spent_by: None,
            commitment_txids: vec![],
            settled_by: None,
            ark_txid: None,
        }
    }

    const TXID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TXID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // ── parse_outpoints ─────────────────────────────────────────

    #[test]
    fn parse_outpoints_valid() {
        let input = vec![format!("{TXID_A}:0"), format!("{TXID_B}:42")];
        let result = parse_outpoints(&input).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].txid.to_string(), TXID_A);
        assert_eq!(result[0].vout, 0);
        assert_eq!(result[1].vout, 42);
    }

    #[test]
    fn parse_outpoints_empty() {
        let result = parse_outpoints(&[]).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_outpoints_invalid_format() {
        let input = vec!["not-an-outpoint".to_string()];
        let err = parse_outpoints(&input).unwrap_err();
        assert!(err.to_string().contains("invalid outpoint"));
    }

    #[test]
    fn parse_outpoints_invalid_txid() {
        let input = vec!["xyz:0".to_string()];
        assert!(parse_outpoints(&input).is_err());
    }

    // ── collect_vtxos ───────────────────────────────────────────

    #[test]
    fn collect_vtxos_maps_fields() {
        let vtxo = make_vtxo(TXID_A, 1, 5000, 1000, 2000);
        let result = collect_vtxos(std::iter::once(&vtxo), VtxoStatus::Confirmed);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].txid, TXID_A);
        assert_eq!(result[0].vout, 1);
        assert_eq!(result[0].amount_sat, 5000);
        assert_eq!(result[0].created_at, 1000);
        assert_eq!(result[0].expires_at, 2000);
        assert!(matches!(result[0].status, VtxoStatus::Confirmed));
    }

    #[test]
    fn collect_vtxos_preserves_status() {
        let vtxo = make_vtxo(TXID_A, 0, 100, 0, 0);
        let pre = collect_vtxos(std::iter::once(&vtxo), VtxoStatus::PreConfirmed);
        let rec = collect_vtxos(std::iter::once(&vtxo), VtxoStatus::Recoverable);

        assert!(matches!(pre[0].status, VtxoStatus::PreConfirmed));
        assert!(matches!(rec[0].status, VtxoStatus::Recoverable));
    }

    #[test]
    fn collect_vtxos_empty_iterator() {
        let result = collect_vtxos(std::iter::empty(), VtxoStatus::Confirmed);
        assert!(result.is_empty());
    }

    // ── serialization ───────────────────────────────────────────

    #[test]
    fn vtxo_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(VtxoStatus::Confirmed).unwrap(),
            "confirmed"
        );
        assert_eq!(
            serde_json::to_value(VtxoStatus::PreConfirmed).unwrap(),
            "preconfirmed"
        );
        assert_eq!(
            serde_json::to_value(VtxoStatus::Recoverable).unwrap(),
            "recoverable"
        );
    }

    #[test]
    fn vtxo_info_serializes() {
        let info = VtxoInfo {
            txid: TXID_A.to_string(),
            vout: 0,
            amount_sat: 1234,
            created_at: 100,
            expires_at: 200,
            status: VtxoStatus::Confirmed,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["txid"], TXID_A);
        assert_eq!(json["amount_sat"], 1234);
        assert_eq!(json["status"], "confirmed");
    }

    #[test]
    fn renew_result_serializes() {
        let with_txid = RenewResult {
            renewed: true,
            txid: Some("abc".to_string()),
        };
        let without = RenewResult {
            renewed: false,
            txid: None,
        };
        let j1 = serde_json::to_value(&with_txid).unwrap();
        let j2 = serde_json::to_value(&without).unwrap();
        assert_eq!(j1["renewed"], true);
        assert_eq!(j1["txid"], "abc");
        assert_eq!(j2["renewed"], false);
        assert!(j2["txid"].is_null());
    }

    #[test]
    fn fee_estimate_serializes() {
        let est = FeeEstimate { fee_sat: -500 };
        let json = serde_json::to_value(&est).unwrap();
        assert_eq!(json["fee_sat"], -500);
    }
}
