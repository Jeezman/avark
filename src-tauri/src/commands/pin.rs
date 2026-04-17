//! # PIN Security — Threat Model
//!
//! The PIN lock is a **casual access guard**: it deters someone who picks up an
//! unlocked device from immediately accessing the wallet. It is NOT a
//! cryptographic access control and does not protect against a determined
//! attacker with filesystem access.
//!
//! Known limitations:
//! - **4-digit keyspace (10k candidates):** An attacker who reads `settings.json`
//!   can brute-force the salted SHA-256 hash offline in milliseconds.
//! - **Attempt counter is user-writable:** `pin_failed_attempts` lives in
//!   `settings.json`, so an attacker can reset it to zero and retry. The lockout
//!   mechanism only works against in-app brute-forcing, not filesystem-level.
//! - **PIN hash is in the same file:** No separation of trust boundaries.
//!
//! The actual security boundary is the **mnemonic stored in OS secure storage**
//! (Keychain on iOS), which is hardware-backed and not readable from the filesystem.
//!
//! Future hardening options (not in v1):
//! - HMAC the counter with a key stored in the OS keyring
//! - Move the counter into secure storage alongside the mnemonic
//! - Add biometric authentication as an alternative to PIN

use bitcoin::hashes::{sha256, Hash};
use rand::Rng;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{error, info, warn};

use crate::{read_settings, write_settings, AppError, SettingsLock};

#[derive(Serialize, Clone)]
pub(crate) struct SecurityEvent {
    pub kind: &'static str,
    pub detail: &'static str,
}

const DEFAULT_MAX_ATTEMPTS: u32 = 10;
const ATTEMPTS_MIN: u32 = 3;
const ATTEMPTS_MAX: u32 = 10;
const SALT_LEN: usize = 16;

/// Backoff delay in seconds based on cumulative failed attempts.
/// Returns 0 for the first 2 failures, then ramps up.
fn backoff_secs(failed: u32) -> u64 {
    match failed {
        0..=2 => 0,
        3..=4 => 1,
        5..=6 => 5,
        7..=8 => 15,
        _ => 30,
    }
}

/// Check if the account is locked out.
fn is_locked_out(failed: u32, max: u32) -> bool {
    failed >= max
}

/// Given the current failed count, max attempts, and whether the PIN was valid,
/// return `(new_failed_count, attempts_remaining, locked)`.
fn next_attempt_state(failed: u32, max: u32, valid: bool) -> (u32, u32, bool) {
    if valid {
        (0, max, false)
    } else {
        let new_failed = failed + 1;
        let remaining = max.saturating_sub(new_failed);
        (new_failed, remaining, remaining == 0)
    }
}

/// Clamp max attempts and decide whether to reset the failed counter.
/// Returns `(clamped_max, new_failed_count)`.
fn clamp_and_reset(max_attempts: u32, current_failed: u32) -> (u32, u32) {
    let clamped = max_attempts.clamp(ATTEMPTS_MIN, ATTEMPTS_MAX);
    let new_failed = if current_failed >= clamped {
        0
    } else {
        current_failed
    };
    (clamped, new_failed)
}

fn generate_salt() -> String {
    let bytes: [u8; SALT_LEN] = rand::thread_rng().gen();
    hex::encode(bytes)
}

fn hash_pin(pin: &str, salt: &str) -> String {
    let salted = format!("{salt}:{pin}");
    let hash = sha256::Hash::hash(salted.as_bytes());
    format!("{hash:x}")
}

#[derive(Serialize)]
pub struct PinStatus {
    enabled: bool,
    max_attempts: u32,
    attempts_remaining: u32,
    locked: bool,
}

#[tauri::command]
pub async fn get_pin_status(app: tauri::AppHandle) -> Result<PinStatus, AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.read().await;
    let settings = read_settings(&app).await?;

    let enabled = settings.pin_hash.is_some();
    let max = settings.max_pin_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS);
    let failed = settings.pin_failed_attempts.unwrap_or(0);
    let remaining = max.saturating_sub(failed);

    Ok(PinStatus {
        enabled,
        max_attempts: max,
        attempts_remaining: remaining,
        locked: enabled && remaining == 0,
    })
}

#[tauri::command]
pub async fn set_pin(app: tauri::AppHandle, pin: String) -> Result<(), AppError> {
    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Wallet("PIN must be exactly 4 digits".into()));
    }

    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;

    let salt = generate_salt();
    settings.pin_hash = Some(hash_pin(&pin, &salt));
    settings.pin_salt = Some(salt);
    settings.pin_failed_attempts = Some(0);
    if settings.max_pin_attempts.is_none() {
        settings.max_pin_attempts = Some(DEFAULT_MAX_ATTEMPTS);
    }

    write_settings(&app, &settings).await?;
    info!("pin set");
    Ok(())
}

#[derive(Serialize)]
pub struct VerifyPinResult {
    valid: bool,
    attempts_remaining: u32,
    locked: bool,
    /// Seconds the caller must wait before the next attempt (0 = no wait).
    retry_after_secs: u64,
}

#[tauri::command]
pub async fn verify_pin(app: tauri::AppHandle, pin: String) -> Result<VerifyPinResult, AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;

    let stored_hash = settings
        .pin_hash
        .as_deref()
        .ok_or_else(|| AppError::Wallet("No PIN set".into()))?;
    let salt = settings
        .pin_salt
        .as_deref()
        .ok_or_else(|| AppError::Wallet("PIN salt missing".into()))?;

    let max = settings.max_pin_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS);
    let failed = settings.pin_failed_attempts.unwrap_or(0);

    if is_locked_out(failed, max) {
        return Ok(VerifyPinResult {
            valid: false,
            attempts_remaining: 0,
            locked: true,
            retry_after_secs: 0,
        });
    }

    // Enforce backoff before checking — this is server-side so the frontend
    // can't bypass it by calling verify_pin rapidly.
    let delay = backoff_secs(failed);
    if delay > 0 {
        info!(delay_secs = delay, "pin backoff enforced");
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
    }

    use subtle::ConstantTimeEq;
    let input_hash = hash_pin(&pin, salt);
    let valid = input_hash.as_bytes().ct_eq(stored_hash.as_bytes()).into();
    let (new_failed, remaining, locked) = next_attempt_state(failed, max, valid);

    settings.pin_failed_attempts = Some(new_failed);
    write_settings(&app, &settings).await?;

    let retry_after_secs = if valid { 0 } else { backoff_secs(new_failed) };

    if valid {
        info!("pin verification succeeded");
    } else if locked {
        error!("pin lockout triggered; seed-phrase recovery required");
        let _ = app.emit(
            "security-event",
            SecurityEvent {
                kind: "lockout",
                detail: "Too many incorrect PIN attempts",
            },
        );
    } else {
        warn!(
            attempts_remaining = remaining,
            retry_after_secs, "pin verification failed"
        );
        let _ = app.emit(
            "security-event",
            SecurityEvent {
                kind: "pin-failed",
                detail: "Incorrect PIN entered",
            },
        );
    }

    Ok(VerifyPinResult {
        valid,
        attempts_remaining: remaining,
        locked,
        retry_after_secs,
    })
}

#[tauri::command]
pub async fn clear_pin(app: tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;

    settings.pin_hash = None;
    settings.pin_salt = None;
    settings.pin_failed_attempts = Some(0);

    write_settings(&app, &settings).await?;
    info!("pin cleared");
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn set_max_pin_attempts(
    app: tauri::AppHandle,
    max_attempts: u32,
) -> Result<(), AppError> {
    let state = app.state::<SettingsLock>();
    let _lock = state.0.write().await;
    let mut settings = read_settings(&app).await?;

    let current_failed = settings.pin_failed_attempts.unwrap_or(0);
    let (clamped, new_failed) = clamp_and_reset(max_attempts, current_failed);
    settings.max_pin_attempts = Some(clamped);
    settings.pin_failed_attempts = Some(new_failed);

    write_settings(&app, &settings).await?;
    info!(max_attempts = clamped, "max pin attempts updated");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Hashing ────────────────────────────────────────────────────────

    #[test]
    fn pin_hashing_is_deterministic_with_same_salt() {
        let salt = "test-salt-abc";
        assert_eq!(hash_pin("1234", salt), hash_pin("1234", salt));
    }

    #[test]
    fn different_pins_produce_different_hashes() {
        let salt = "test-salt";
        assert_ne!(hash_pin("1234", salt), hash_pin("5678", salt));
    }

    #[test]
    fn same_pin_different_salts_produce_different_hashes() {
        assert_ne!(hash_pin("1234", "salt-a"), hash_pin("1234", "salt-b"));
    }

    #[test]
    fn pin_hash_differs_from_unsalted() {
        let raw = format!("{:x}", sha256::Hash::hash(b"1234"));
        assert_ne!(hash_pin("1234", "any-salt"), raw);
    }

    #[test]
    fn generated_salt_is_unique() {
        let a = generate_salt();
        let b = generate_salt();
        assert_ne!(a, b);
        assert_eq!(a.len(), SALT_LEN * 2); // hex-encoded
    }

    // ── Lockout detection ──────────────────────────────────────────────

    #[test]
    fn not_locked_when_under_max() {
        assert!(!is_locked_out(0, 10));
        assert!(!is_locked_out(9, 10));
    }

    #[test]
    fn locked_at_max() {
        assert!(is_locked_out(10, 10));
    }

    #[test]
    fn locked_above_max() {
        assert!(is_locked_out(11, 10));
    }

    #[test]
    fn locked_at_minimum_max() {
        assert!(is_locked_out(3, 3));
    }

    // ── Attempt state transitions ──────────────────────────────────────

    #[test]
    fn valid_pin_resets_counter() {
        let (new_failed, remaining, locked) = next_attempt_state(5, 10, true);
        assert_eq!(new_failed, 0);
        assert_eq!(remaining, 10);
        assert!(!locked);
    }

    #[test]
    fn invalid_pin_increments_counter() {
        let (new_failed, remaining, locked) = next_attempt_state(2, 10, false);
        assert_eq!(new_failed, 3);
        assert_eq!(remaining, 7);
        assert!(!locked);
    }

    #[test]
    fn last_attempt_triggers_lockout() {
        let (new_failed, remaining, locked) = next_attempt_state(9, 10, false);
        assert_eq!(new_failed, 10);
        assert_eq!(remaining, 0);
        assert!(locked);
    }

    #[test]
    fn first_failed_attempt() {
        let (new_failed, remaining, locked) = next_attempt_state(0, 5, false);
        assert_eq!(new_failed, 1);
        assert_eq!(remaining, 4);
        assert!(!locked);
    }

    #[test]
    fn lockout_at_minimum_max_attempts() {
        let (new_failed, remaining, locked) = next_attempt_state(2, 3, false);
        assert_eq!(new_failed, 3);
        assert_eq!(remaining, 0);
        assert!(locked);
    }

    #[test]
    fn valid_pin_after_many_failures_resets() {
        let (new_failed, remaining, locked) = next_attempt_state(9, 10, true);
        assert_eq!(new_failed, 0);
        assert_eq!(remaining, 10);
        assert!(!locked);
    }

    // ── Clamp and reset ────────────────────────────────────────────────

    #[test]
    fn clamp_within_range() {
        let (max, failed) = clamp_and_reset(7, 2);
        assert_eq!(max, 7);
        assert_eq!(failed, 2);
    }

    #[test]
    fn clamp_below_minimum() {
        let (max, failed) = clamp_and_reset(1, 0);
        assert_eq!(max, ATTEMPTS_MIN);
        assert_eq!(failed, 0);
    }

    #[test]
    fn clamp_above_maximum() {
        let (max, failed) = clamp_and_reset(99, 0);
        assert_eq!(max, ATTEMPTS_MAX);
        assert_eq!(failed, 0);
    }

    #[test]
    fn reset_failed_when_exceeds_new_max() {
        let (max, failed) = clamp_and_reset(5, 7);
        assert_eq!(max, 5);
        assert_eq!(failed, 0);
    }

    #[test]
    fn reset_failed_when_equals_new_max() {
        let (max, failed) = clamp_and_reset(5, 5);
        assert_eq!(max, 5);
        assert_eq!(failed, 0);
    }

    #[test]
    fn keep_failed_when_under_new_max() {
        let (max, failed) = clamp_and_reset(5, 4);
        assert_eq!(max, 5);
        assert_eq!(failed, 4);
    }
}
