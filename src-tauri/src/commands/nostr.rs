//! Nostr identity commands.
//!
//! The user's `nsec` is held in OS secure storage and never crosses the IPC
//! boundary — only the `npub` and broadcast outcomes are returned.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nostr_sdk::{Client, Filter, Kind};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    nostr::{relays::DEFAULT_RELAYS, Keypair, Metadata, PublicKey, ToBech32, NSEC_KEY},
    secure_storage::SecureStorage,
    AppError, NostrGenerateLock,
};

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize)]
pub struct Identity {
    pub npub: String,
}

#[derive(Serialize)]
pub struct CurrentIdentity {
    pub npub: Option<String>,
}

fn npub_from_keys(keys: &Keypair) -> Result<String, AppError> {
    keys.public_key()
        .to_bech32()
        .map_err(|e| AppError::Nostr(format!("encode npub: {e}")))
}

/// Pure: given the value currently in secure storage (or `None`), derive the npub.
fn npub_from_stored_nsec(stored: Option<String>) -> Result<Option<String>, AppError> {
    let Some(existing) = stored else {
        return Ok(None);
    };
    let keys = Keypair::parse(&existing)
        .map_err(|e| AppError::Nostr(format!("decode stored nsec: {e}")))?;
    Ok(Some(npub_from_keys(&keys)?))
}

/// Outcome of the generate-or-recover decision.
#[cfg_attr(test, derive(Debug))]
enum GenerateOutcome {
    Existing { npub: String },
    Generated { npub: String, nsec: String },
}

/// Pure: given the value currently in secure storage, decide whether to return
/// the existing identity or generate a new one. Caller is responsible for
/// persisting the `nsec` from `Generated`.
fn compute_generate(stored: Option<String>) -> Result<GenerateOutcome, AppError> {
    if let Some(existing) = stored {
        let keys = Keypair::parse(&existing)
            .map_err(|e| AppError::Nostr(format!("decode stored nsec: {e}")))?;
        return Ok(GenerateOutcome::Existing {
            npub: npub_from_keys(&keys)?,
        });
    }

    let keys = Keypair::generate();
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| AppError::Nostr(format!("encode nsec: {e}")))?;
    Ok(GenerateOutcome::Generated {
        npub: npub_from_keys(&keys)?,
        nsec,
    })
}

/// Generate a new Nostr identity, or return the existing one if already present.
///
/// The read-generate-write sequence is serialized by `NostrGenerateLock` so
/// concurrent callers can't both observe an empty NSEC_KEY and
/// generate competing keypairs.
#[tauri::command]
pub async fn nostr_generate_identity(app: AppHandle) -> Result<Identity, AppError> {
    let lock = app.state::<NostrGenerateLock>();
    let _guard = lock.0.lock().await;

    let store = SecureStorage::get_instance(&app);
    match compute_generate(store.get(NSEC_KEY)?)? {
        GenerateOutcome::Existing { npub } => Ok(Identity { npub }),
        GenerateOutcome::Generated { npub, nsec } => {
            store.set(NSEC_KEY, &nsec)?;
            Ok(Identity { npub })
        }
    }
}

/// Read the current Nostr identity. Returns `npub: None` when no identity exists.
#[tauri::command]
pub async fn nostr_get_identity(app: AppHandle) -> Result<CurrentIdentity, AppError> {
    let store = SecureStorage::get_instance(&app);
    Ok(CurrentIdentity {
        npub: npub_from_stored_nsec(store.get(NSEC_KEY)?)?,
    })
}

/// Reveal the user's `nsec` for backup.
#[tauri::command]
pub async fn nostr_reveal_nsec(app: AppHandle) -> Result<String, AppError> {
    let store = SecureStorage::get_instance(&app);
    store
        .get(NSEC_KEY)?
        .ok_or_else(|| AppError::Nostr("no Nostr identity stored".into()))
}

#[derive(Serialize)]
pub struct PublishResult {
    pub event_id: String,
    pub accepted_relays: Vec<String>,
}

/// Publish the user's `kind:0` profile metadata to the default relay set.
///
/// Connects to all default relays and broadcasts in parallel via `nostr-sdk`.
/// Returns the event ID and the subset of relays that accepted the event.
/// Errors if no Nostr identity has been provisioned yet.
#[tauri::command]
pub async fn nostr_publish_metadata(
    app: AppHandle,
    metadata: Metadata,
) -> Result<PublishResult, AppError> {
    let store = SecureStorage::get_instance(&app);
    let nsec = store
        .get(NSEC_KEY)?
        .ok_or_else(|| AppError::Nostr("no Nostr identity stored; generate one first".into()))?;
    let keys =
        Keypair::parse(&nsec).map_err(|e| AppError::Nostr(format!("decode stored nsec: {e}")))?;

    let client = Client::new(keys);
    for url in DEFAULT_RELAYS {
        client
            .add_relay(*url)
            .await
            .map_err(|e| AppError::Nostr(format!("add relay {url}: {e}")))?;
    }
    client.connect().await;

    let output = client
        .set_metadata(&metadata)
        .await
        .map_err(|e| AppError::Nostr(format!("publish metadata: {e}")))?;

    let event_id = output.val.to_hex();
    let accepted_relays: Vec<String> = output.success.iter().map(|url| url.to_string()).collect();

    Ok(PublishResult {
        event_id,
        accepted_relays,
    })
}

#[derive(Serialize)]
pub struct FetchMetadataResult {
    pub metadata: Option<Metadata>,
    pub fetched_at: u64,
}

/// Parse a `kind:0` event's content as `Metadata`. Returns `None` for malformed
/// JSON, with a warning logged so developers can distinguish "no profile
/// published" from "profile published but unparseable" via logcat.
fn parse_metadata_content(content: &str) -> Option<Metadata> {
    match serde_json::from_str::<Metadata>(content) {
        Ok(m) => Some(m),
        Err(e) => {
            tracing::warn!(
                error = %e,
                preview = %content.chars().take(120).collect::<String>(),
                "kind:0 event has unparseable content; treating as absent"
            );
            None
        }
    }
}

/// Fetch the latest `kind:0` metadata event for the given `npub` from the
/// default relay set.
///
/// 5-second timeout: if no event is returned in that window, `metadata` is
/// `None`. No caching — every call hits the relays.
#[tauri::command]
pub async fn nostr_fetch_metadata(npub: String) -> Result<FetchMetadataResult, AppError> {
    let pubkey =
        PublicKey::parse(&npub).map_err(|e| AppError::Nostr(format!("invalid npub: {e}")))?;

    let client = Client::default();
    for url in DEFAULT_RELAYS {
        client
            .add_relay(*url)
            .await
            .map_err(|e| AppError::Nostr(format!("add relay {url}: {e}")))?;
    }
    client.connect().await;

    let filter = Filter::new().author(pubkey).kind(Kind::Metadata).limit(1);

    let events = client
        .fetch_events(filter, FETCH_TIMEOUT)
        .await
        .map_err(|e| AppError::Nostr(format!("fetch events: {e}")))?;

    let metadata = events
        .into_iter()
        .next()
        .and_then(|ev| parse_metadata_content(&ev.content));

    let fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(FetchMetadataResult {
        metadata,
        fetched_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npub_from_stored_nsec_none_returns_none() {
        let result = npub_from_stored_nsec(None).expect("should not error");
        assert!(result.is_none());
    }

    #[test]
    fn npub_from_stored_nsec_some_valid_returns_matching_npub() {
        let keys = Keypair::generate();
        let nsec = keys.secret_key().to_bech32().unwrap();
        let expected_npub = keys.public_key().to_bech32().unwrap();

        let result = npub_from_stored_nsec(Some(nsec)).expect("should not error");
        assert_eq!(result, Some(expected_npub));
    }

    #[test]
    fn npub_from_stored_nsec_some_invalid_returns_error() {
        let err = npub_from_stored_nsec(Some("not-a-real-nsec".into()))
            .expect_err("malformed nsec must error");
        assert!(matches!(err, AppError::Nostr(_)));
    }

    #[test]
    fn compute_generate_none_produces_consistent_keypair() {
        let outcome = compute_generate(None).expect("should generate");
        let (npub, nsec) = match outcome {
            GenerateOutcome::Generated { npub, nsec } => (npub, nsec),
            GenerateOutcome::Existing { .. } => panic!("expected Generated, got Existing"),
        };

        // The generated nsec round-trips back to the generated npub.
        let recovered = Keypair::parse(&nsec).unwrap();
        assert_eq!(recovered.public_key().to_bech32().unwrap(), npub);
    }

    #[test]
    fn compute_generate_existing_returns_matching_npub() {
        let keys = Keypair::generate();
        let nsec = keys.secret_key().to_bech32().unwrap();
        let expected_npub = keys.public_key().to_bech32().unwrap();

        let outcome = compute_generate(Some(nsec)).expect("should recover");
        match outcome {
            GenerateOutcome::Existing { npub } => assert_eq!(npub, expected_npub),
            GenerateOutcome::Generated { .. } => panic!("expected Existing, got Generated"),
        }
    }

    #[test]
    fn compute_generate_is_idempotent() {
        // First call with empty storage generates a new identity.
        let first = compute_generate(None).expect("first should generate");
        let (first_npub, persisted_nsec) = match first {
            GenerateOutcome::Generated { npub, nsec } => (npub, nsec),
            GenerateOutcome::Existing { .. } => panic!("first call must generate"),
        };

        // Second call sees the persisted nsec and returns the same npub.
        let second = compute_generate(Some(persisted_nsec)).expect("second should recover");
        match second {
            GenerateOutcome::Existing { npub } => assert_eq!(npub, first_npub),
            GenerateOutcome::Generated { .. } => panic!("second call must NOT regenerate"),
        }
    }

    #[test]
    fn compute_generate_invalid_storage_returns_error() {
        let err =
            compute_generate(Some("garbage".into())).expect_err("invalid stored nsec must error");
        assert!(matches!(err, AppError::Nostr(_)));
    }

    #[test]
    fn parse_metadata_content_accepts_valid_json() {
        let parsed = parse_metadata_content(r#"{"name":"alice","about":"hi"}"#)
            .expect("valid kind:0 content should parse");
        assert_eq!(parsed.name.as_deref(), Some("alice"));
        assert_eq!(parsed.about.as_deref(), Some("hi"));
    }

    #[test]
    fn parse_metadata_content_accepts_empty_object() {
        // Every Metadata field is optional, so `{}` is a valid (empty) profile.
        assert!(parse_metadata_content("{}").is_some());
    }

    #[test]
    fn parse_metadata_content_drops_malformed_json() {
        // Truncated JSON: no chance of a valid Metadata.
        assert!(parse_metadata_content("{not json").is_none());
    }

    #[test]
    fn parse_metadata_content_drops_wrong_shape() {
        // Valid JSON, wrong shape — Metadata requires an object.
        assert!(parse_metadata_content("[]").is_none());
        assert!(parse_metadata_content("\"just a string\"").is_none());
    }
}
