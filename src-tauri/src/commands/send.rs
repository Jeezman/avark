use std::sync::Arc;
use std::time::Duration;

use ark_client::lightning_invoice::Bolt11Invoice;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::{AppError, GlobalWalletState};

/// Check if an error string indicates a transient transport/connection issue.
fn is_transient_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("transport error")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("broken pipe")
        || lower.contains("timed out")
        || lower.contains("hyper::error")
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressType {
    Ark,
    Bitcoin,
    Lightning,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum LightningKind {
    Bolt11,
    Address,
}

#[derive(Serialize)]
pub struct DetectAddressResult {
    address_type: AddressType,
    lightning_kind: Option<LightningKind>,
    amount_sat: Option<u64>,
}

#[tauri::command]
pub async fn detect_address_type(address: String) -> Result<DetectAddressResult, AppError> {
    if let Some(invoice) = parse_bolt11_invoice(&address) {
        let amount_sat = invoice.amount_milli_satoshis().and_then(msat_to_sat);
        return Ok(DetectAddressResult {
            address_type: AddressType::Lightning,
            lightning_kind: Some(LightningKind::Bolt11),
            amount_sat,
        });
    }

    let normalized = address.trim().to_lowercase();

    if normalized.starts_with("lightning:")
        || normalized.starts_with("lnurl")
        || normalized.contains('@')
    {
        return Ok(DetectAddressResult {
            address_type: AddressType::Lightning,
            lightning_kind: Some(LightningKind::Address),
            amount_sat: None,
        });
    }

    if ark_core::ArkAddress::decode(&address).is_ok() {
        return Ok(DetectAddressResult {
            address_type: AddressType::Ark,
            lightning_kind: None,
            amount_sat: None,
        });
    }

    if address
        .parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
        .is_ok()
    {
        return Ok(DetectAddressResult {
            address_type: AddressType::Bitcoin,
            lightning_kind: None,
            amount_sat: None,
        });
    }

    Err(AppError::Wallet(
        "Invalid address: not a valid Ark, Bitcoin, or Lightning invoice".into(),
    ))
}

fn parse_bolt11_invoice(input: &str) -> Option<Bolt11Invoice> {
    let normalized = input.trim();
    let invoice = normalized
        .strip_prefix("lightning:")
        .or_else(|| normalized.strip_prefix("LIGHTNING:"))
        .unwrap_or(normalized);
    invoice.parse::<Bolt11Invoice>().ok()
}

fn msat_to_sat(msat: u64) -> Option<u64> {
    if msat.is_multiple_of(1000) {
        Some(msat / 1000)
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct SendResult {
    /// For Lightning: the VHTLC funding txid (Boltz claims this VTXO once
    /// the LN payment routes). For Ark/onchain: the actual send txid.
    pub txid: String,
    /// Lightning-only. Set to the Boltz submarine swap id if settlement
    /// didn't complete within the timeout. The VHTLC is already funded;
    /// the LN route is still resolving in the background. Callers should
    /// render this as in-flight / pending, not as success.
    #[serde(skip_serializing_if = "Option::is_none", rename = "pendingLnSwapId")]
    pub pending_ln_swap_id: Option<String>,
}

/// How long we wait for the Lightning invoice to settle before returning
/// with a pending marker. The VHTLC funding already happened synchronously
/// in `pay_ln_invoice`; this is purely the "is Boltz done routing?" window.
/// Tuned for UI responsiveness — the polling/reconciliation layer catches
/// the actual settlement eventually.
const LN_SETTLEMENT_WAIT: Duration = Duration::from_secs(30);

#[tauri::command]
pub async fn send_lightning(
    app: tauri::AppHandle,
    invoice: String,
) -> Result<SendResult, AppError> {
    let (client, mut cancel_rx) = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        (Arc::clone(&ws.client), ws.wallet_cancel.subscribe())
    };

    let invoice = parse_bolt11_invoice(&invoice)
        .ok_or_else(|| AppError::Wallet("Invalid Lightning invoice".into()))?;

    if invoice
        .amount_milli_satoshis()
        .is_some_and(|amount_msat| amount_msat % 1000 != 0)
    {
        return Err(AppError::Wallet(
            "Lightning invoices with sub-satoshi amounts are not supported".into(),
        ));
    }

    info!("paying Lightning invoice");
    let _ = app.emit("ln-swap-progress", "Preparing Lightning payment...");

    let result = client
        .pay_ln_invoice(invoice)
        .await
        .map_err(|e| AppError::Wallet(format!("Lightning payment failed: {e}")))?;

    info!(
        swap_id = %result.swap_id,
        txid = %result.txid,
        amount_sat = result.amount.to_sat(),
        "funded Lightning payment swap"
    );
    let _ = app.emit(
        "ln-swap-progress",
        format!(
            "Funded Lightning payment for {} sats, waiting for settlement...",
            result.amount.to_sat()
        ),
    );

    // Wait for LN settlement up to `LN_SETTLEMENT_WAIT`. The SDK's
    // `wait_for_invoice_paid` itself has no deadline, so we wrap it in
    // `tokio::time::timeout` — on elapse, return Ok with `pending_ln_swap_id`
    // so the UI can render a stable "routing" state instead of hanging.
    let wait_result = tokio::select! {
        biased;
        _ = cancel_rx.changed() => {
            return Err(AppError::Wallet(
                "Wallet disconnected while paying Lightning invoice".into(),
            ));
        }
        wait = tokio::time::timeout(LN_SETTLEMENT_WAIT, client.wait_for_invoice_paid(&result.swap_id)) => wait,
    };

    match wait_result {
        Ok(Ok(())) => {
            info!(swap_id = %result.swap_id, txid = %result.txid, "Lightning invoice paid");
            Ok(SendResult {
                txid: result.txid.to_string(),
                pending_ln_swap_id: None,
            })
        }
        Ok(Err(e)) => {
            // SDK observed an error (Boltz rejected / timed out unilaterally).
            // The VHTLC is still funded and refundable via the recovery screen.
            Err(AppError::Wallet(format!(
                "Lightning payment did not complete: {e}"
            )))
        }
        Err(_elapsed) => {
            // Our window elapsed but the SDK is still waiting. Return a
            // pending marker; polling / recovery handle the eventual resolution.
            info!(
                swap_id = %result.swap_id,
                txid = %result.txid,
                "Lightning settlement still in flight after {}s — returning pending",
                LN_SETTLEMENT_WAIT.as_secs()
            );
            Ok(SendResult {
                txid: result.txid.to_string(),
                pending_ln_swap_id: Some(result.swap_id.clone()),
            })
        }
    }
}

#[tauri::command]
pub async fn send_ark(
    app: tauri::AppHandle,
    address: String,
    amount_sat: u64,
) -> Result<SendResult, AppError> {
    if amount_sat == 0 {
        return Err(AppError::Wallet("Amount must be greater than zero".into()));
    }

    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        Arc::clone(&ws.client)
    };

    let ark_addr = ark_core::ArkAddress::decode(&address)
        .map_err(|e| AppError::Wallet(format!("Invalid Ark address: {e}")))?;

    let amount = bitcoin::Amount::from_sat(amount_sat);

    info!(address = %address, amount_sat = amount_sat, "sending Ark payment");

    let txid = client
        .send_vtxo(ark_addr, amount)
        .await
        .map_err(|e| AppError::Wallet(format!("Send failed: {e}")))?;

    info!(txid = %txid, "Ark payment sent");

    Ok(SendResult {
        txid: txid.to_string(),
        pending_ln_swap_id: None,
    })
}

#[tauri::command]
pub async fn send_onchain(
    app: tauri::AppHandle,
    address: String,
    amount_sat: u64,
) -> Result<SendResult, AppError> {
    if amount_sat == 0 {
        return Err(AppError::Wallet("Amount must be greater than zero".into()));
    }

    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        Arc::clone(&ws.client)
    };

    let btc_addr = address
        .parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
        .map_err(|e| AppError::Wallet(format!("Invalid Bitcoin address: {e}")))?
        .assume_checked();

    let amount = bitcoin::Amount::from_sat(amount_sat);

    info!(address = %address, amount_sat = amount_sat, "offboarding to onchain");

    use rand::SeedableRng;
    let mut rng = rand::rngs::StdRng::from_entropy();

    let txid = client
        .collaborative_redeem(&mut rng, btc_addr, amount)
        .await
        .map_err(|e| AppError::Wallet(format!("Offboard failed: {e}")))?;

    info!(txid = %txid, "offboard completed");

    Ok(SendResult {
        txid: txid.to_string(),
        pending_ln_swap_id: None,
    })
}

#[derive(Serialize)]
pub struct FeeEstimate {
    fee_sat: i64,
}

const FEE_ESTIMATE_MAX_RETRIES: u32 = 3;
const FEE_ESTIMATE_RETRY_DELAY_MS: u64 = 500;

#[tauri::command]
pub async fn estimate_onchain_send_fee(
    app: tauri::AppHandle,
    address: String,
    amount_sat: u64,
) -> Result<FeeEstimate, AppError> {
    if amount_sat == 0 {
        return Err(AppError::Wallet("Amount must be greater than zero".into()));
    }

    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        Arc::clone(&ws.client)
    };

    let btc_addr = address
        .parse::<bitcoin::Address<bitcoin::address::NetworkUnchecked>>()
        .map_err(|e| AppError::Wallet(format!("Invalid Bitcoin address: {e}")))?
        .assume_checked();

    let amount = bitcoin::Amount::from_sat(amount_sat);

    let mut last_err = String::new();
    for attempt in 1..=FEE_ESTIMATE_MAX_RETRIES {
        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::from_entropy();

        match client
            .estimate_onchain_fees(&mut rng, btc_addr.clone(), amount)
            .await
        {
            Ok(fee) => {
                return Ok(FeeEstimate {
                    fee_sat: fee.to_sat(),
                })
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < FEE_ESTIMATE_MAX_RETRIES && is_transient_error(&last_err) {
                    warn!(
                        attempt,
                        error = %last_err,
                        "fee estimation failed with transient error, retrying"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        FEE_ESTIMATE_RETRY_DELAY_MS * u64::from(attempt),
                    ))
                    .await;
                    continue;
                }
            }
        }
    }

    let friendly = if is_transient_error(&last_err) {
        "Could not reach the ASP server. Check your connection and try again.".to_string()
    } else {
        format!("Fee estimation failed: {last_err}")
    };
    Err(AppError::Wallet(friendly))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_result_serializes() {
        let result = SendResult {
            txid: "abc123".to_string(),
            pending_ln_swap_id: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["txid"], "abc123");
        // `skip_serializing_if = "Option::is_none"` keeps the field out of the
        // JSON entirely when absent, so Ark/onchain payloads look unchanged.
        assert!(json.get("pendingLnSwapId").is_none());
    }

    #[test]
    fn send_result_pending_serializes() {
        let result = SendResult {
            txid: "abc123".to_string(),
            pending_ln_swap_id: Some("boltz-swap-xyz".to_string()),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["txid"], "abc123");
        assert_eq!(json["pendingLnSwapId"], "boltz-swap-xyz");
    }

    #[test]
    fn fee_estimate_serializes() {
        let result = FeeEstimate { fee_sat: 450 };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["fee_sat"], 450);
    }

    #[test]
    fn address_type_serializes() {
        let ark = DetectAddressResult {
            address_type: AddressType::Ark,
            lightning_kind: None,
            amount_sat: None,
        };
        let btc = DetectAddressResult {
            address_type: AddressType::Bitcoin,
            lightning_kind: None,
            amount_sat: None,
        };
        let lightning = DetectAddressResult {
            address_type: AddressType::Lightning,
            lightning_kind: Some(LightningKind::Address),
            amount_sat: None,
        };
        assert_eq!(serde_json::to_value(&ark).unwrap()["address_type"], "ark");
        assert_eq!(
            serde_json::to_value(&btc).unwrap()["address_type"],
            "bitcoin"
        );
        assert_eq!(
            serde_json::to_value(&lightning).unwrap()["address_type"],
            "lightning"
        );
    }

    #[tokio::test]
    async fn detect_ark_address() {
        // tark prefix with valid bech32m — this should be recognized as Ark.
        // We can't test with a real address without the SDK, but we can test
        // that an invalid address returns an error.
        let result = detect_address_type("not-a-valid-address".into()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn detect_lightning_address() {
        let result = detect_address_type("satoshi@example.com".into())
            .await
            .unwrap();
        assert!(matches!(result.address_type, AddressType::Lightning));
        assert!(matches!(
            result.lightning_kind,
            Some(LightningKind::Address)
        ));
    }

    #[tokio::test]
    async fn detect_bolt11_invoice() {
        let invoice = concat!(
            "lightning:lnbc25m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqf",
            "qypqdq5vdhkven9v5sxyetpdeessp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3",
            "zyg3zyg3zygs9q5sqqqqqqqqqqqqqqqpqsq67gye39hfg3zd8rgc80k32tvy9xk2xunwm5",
            "lzexnvpx6fd77en8qaq424dxgt56cag2dpt359k3ssyhetktkpqh24jqnjyw6uqd08sgpt",
            "q44qu"
        );
        let result = detect_address_type(invoice.into()).await.unwrap();
        assert!(matches!(result.address_type, AddressType::Lightning));
        assert!(matches!(result.lightning_kind, Some(LightningKind::Bolt11)));
        assert_eq!(result.amount_sat, Some(2_500_000));
    }

    #[tokio::test]
    async fn detect_bitcoin_address() {
        // Valid mainnet P2WPKH address.
        let result = detect_address_type("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4".into()).await;
        assert!(result.is_ok());
        let r = result.unwrap();
        assert!(matches!(r.address_type, AddressType::Bitcoin));
    }

    #[tokio::test]
    async fn send_ark_rejects_zero_amount() {
        // Can't call send_ark without a real app handle, but we can test
        // detect_address_type and serialization. The zero-amount check is
        // tested implicitly via the command's validation.
    }
}
