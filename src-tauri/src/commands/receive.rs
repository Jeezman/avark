use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use super::lightning::PaymentReceived;
use crate::{AppError, GlobalWalletState};

/// Maximum number of consecutive reconnect attempts before giving up.
const MAX_RECONNECT_ATTEMPTS: u32 = 5;
/// Initial backoff delay between reconnect attempts.
const INITIAL_BACKOFF: Duration = Duration::from_secs(2);
/// Maximum backoff delay between reconnect attempts.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Holds the active receive subscription's cancellation handle and subscription ID.
pub(crate) struct ActiveSubscription {
    /// Dropping this sender signals the background task to stop.
    _cancel: tokio::sync::watch::Sender<()>,
    subscription_id: String,
    /// The Ark address strings we subscribed to (needed for unsubscribe).
    address_str: String,
}

/// Managed state: at most one active receive subscription at a time.
pub(crate) struct ReceiveSubscriptionState(pub(crate) Mutex<Option<ActiveSubscription>>);

#[derive(Serialize, Clone)]
pub(crate) struct ReceiveSubResult {
    subscription_id: String,
}

#[tauri::command]
pub async fn start_receive_subscription(
    app: tauri::AppHandle,
    ark_address: String,
) -> Result<ReceiveSubResult, AppError> {
    // Stop any existing subscription first.
    stop_receive_subscription_inner(&app).await;

    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        let ws = guard
            .as_ref()
            .ok_or_else(|| AppError::Wallet("Wallet not connected".into()))?;
        Arc::clone(&ws.client)
    };

    // Decode the address the frontend is actually displaying, so the
    // subscription watches the exact same address shown in the QR code.
    let ark_addr = ark_core::ArkAddress::decode(&ark_address)
        .map_err(|e| AppError::Wallet(format!("Invalid Ark address: {e}")))?;

    let address_str = ark_address;

    // Subscribe to scripts via the Ark client.
    let subscription_id = client
        .subscribe_to_scripts(vec![ark_addr], None)
        .await
        .map_err(|e| AppError::Wallet(format!("Failed to subscribe: {e}")))?;

    info!(subscription_id = %subscription_id, "started receive subscription");

    // Get the subscription stream. If this fails, clean up the server-side
    // subscription so it doesn't leak.
    let stream = match client.get_subscription(subscription_id.clone()).await {
        Ok(s) => s,
        Err(e) => {
            let addr = ark_core::ArkAddress::decode(&address_str);
            if let Ok(addr) = addr {
                let _ = client
                    .unsubscribe_from_scripts(vec![addr], subscription_id)
                    .await;
            }
            return Err(AppError::Wallet(format!(
                "Failed to get subscription stream: {e}"
            )));
        }
    };

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(());

    let bg_app = app.clone();
    let bg_client = Arc::clone(&client);
    let bg_address_str = address_str.clone();
    tokio::spawn(async move {
        let mut current_stream = stream;
        let mut reconnect_attempts: u32 = 0;

        'outer: loop {
            // Consume the current stream.
            loop {
                tokio::select! {
                    biased;
                    _ = cancel_rx.changed() => {
                        debug!("receive subscription cancelled");
                        break 'outer;
                    }
                    item = current_stream.next() => {
                        match item {
                            Some(Ok(ark_core::server::SubscriptionResponse::Event(event))) => {
                                reconnect_attempts = 0;
                                let total_sats: u64 = event
                                    .new_vtxos
                                    .iter()
                                    .map(|v| v.amount.to_sat())
                                    .sum();
                                if total_sats > 0 {
                                    info!(
                                        amount_sat = total_sats,
                                        vtxo_count = event.new_vtxos.len(),
                                        "payment received via Ark subscription"
                                    );
                                    let _ = bg_app.emit(
                                        "payment-received",
                                        PaymentReceived { amount_sat: total_sats },
                                    );
                                }
                            }
                            Some(Ok(ark_core::server::SubscriptionResponse::Heartbeat)) => {
                                reconnect_attempts = 0;
                            }
                            Some(Err(e)) => {
                                warn!(error = %e, "receive subscription stream error");
                                break; // break inner loop → try reconnect
                            }
                            None => {
                                debug!("receive subscription stream ended");
                                break; // break inner loop → try reconnect
                            }
                        }
                    }
                }
            }

            // Stream broke — attempt to reconnect with backoff.
            reconnect_attempts += 1;
            if reconnect_attempts > MAX_RECONNECT_ATTEMPTS {
                warn!(
                    attempts = MAX_RECONNECT_ATTEMPTS,
                    "receive subscription: max reconnect attempts reached, giving up"
                );
                let _ = bg_app.emit(
                    "wallet-sync-error",
                    "Receive subscription lost — close and reopen to retry".to_string(),
                );
                break 'outer;
            }

            let backoff = std::cmp::min(
                INITIAL_BACKOFF * 2u32.saturating_pow(reconnect_attempts - 1),
                MAX_BACKOFF,
            );
            info!(
                attempt = reconnect_attempts,
                backoff_secs = backoff.as_secs(),
                "receive subscription: reconnecting"
            );

            tokio::select! {
                biased;
                _ = cancel_rx.changed() => {
                    debug!("receive subscription cancelled during reconnect backoff");
                    break 'outer;
                }
                _ = tokio::time::sleep(backoff) => {}
            }

            // Re-subscribe and get a fresh stream.
            let Ok(ark_addr) = ark_core::ArkAddress::decode(&bg_address_str) else {
                warn!("failed to decode address for reconnect");
                break 'outer;
            };

            let new_sub_id = match bg_client.subscribe_to_scripts(vec![ark_addr], None).await {
                Ok(id) => id,
                Err(e) => {
                    warn!(error = %e, "receive subscription: re-subscribe failed");
                    continue; // retry after next backoff
                }
            };

            match bg_client.get_subscription(new_sub_id.clone()).await {
                Ok(s) => {
                    info!(subscription_id = %new_sub_id, "receive subscription: reconnected");
                    current_stream = s;
                    // Don't reset reconnect_attempts here — only reset on a
                    // successful message (Event/Heartbeat) to confirm the
                    // stream is truly healthy.
                }
                Err(e) => {
                    warn!(error = %e, "receive subscription: get_subscription failed after re-subscribe");
                    continue; // retry after next backoff
                }
            }
        }

        // Task is exiting — clear the stale state entry so stop_receive_subscription_inner
        // doesn't try to clean up an already-dead subscription.
        let sub_state = bg_app.state::<ReceiveSubscriptionState>();
        sub_state.0.lock().await.take();
    });

    // Store the active subscription.
    let sub_state = app.state::<ReceiveSubscriptionState>();
    *sub_state.0.lock().await = Some(ActiveSubscription {
        _cancel: cancel_tx,
        subscription_id: subscription_id.clone(),
        address_str,
    });

    Ok(ReceiveSubResult { subscription_id })
}

/// Inner cleanup logic shared by the command and start (to stop previous subscriptions).
///
/// Drops the cancellation sender immediately so the background task stops, then
/// spawns the server-side unsubscribe as a fire-and-forget task so it never
/// blocks a subsequent start.
async fn stop_receive_subscription_inner(app: &tauri::AppHandle) {
    let sub_state = app.state::<ReceiveSubscriptionState>();
    let prev = sub_state.0.lock().await.take();

    let Some(sub) = prev else { return };

    info!(subscription_id = %sub.subscription_id, "stopping receive subscription");

    // Destructure so _cancel is dropped immediately, signalling the background
    // task to exit before we do anything else.
    let ActiveSubscription {
        _cancel,
        subscription_id,
        address_str,
    } = sub;
    drop(_cancel);

    // Fire-and-forget: clean up the server-side subscription without blocking
    // the caller. If the wallet is already disconnected or the address can't be
    // decoded, there's nothing useful to do.
    let client = {
        let state = app.state::<GlobalWalletState>();
        let guard = state.0.read().await;
        guard.as_ref().map(|ws| Arc::clone(&ws.client))
    };

    if let Some(client) = client {
        tokio::spawn(async move {
            let Ok(addr) = ark_core::ArkAddress::decode(&address_str) else {
                warn!(address = %address_str, "failed to decode address for unsubscribe");
                return;
            };
            if let Err(e) = client
                .unsubscribe_from_scripts(vec![addr], subscription_id.clone())
                .await
            {
                warn!(
                    subscription_id = %subscription_id,
                    error = %e,
                    "failed to unsubscribe from scripts"
                );
            }
        });
    }
}

#[tauri::command]
pub async fn stop_receive_subscription(app: tauri::AppHandle) -> Result<(), AppError> {
    stop_receive_subscription_inner(&app).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_sub_result_serializes() {
        let result = ReceiveSubResult {
            subscription_id: "test-sub-123".to_string(),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["subscription_id"], "test-sub-123");
    }
}
