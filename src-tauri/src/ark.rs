use ark_client::wallet::Persistence;
use ark_client::{Blockchain, Error, SpendStatus, TxStatus};
use ark_core::ExplorerUtxo;
use bitcoin::{Address, Amount, OutPoint, Transaction, Txid};
use esplora_client::OutputStatus;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;
use zeroize::Zeroize;

/// Total attempts (first try included) for a transient esplora request.
const ESPLORA_MAX_ATTEMPTS: usize = 3;
/// Backoff before the first retry; doubles for each subsequent retry.
const ESPLORA_RETRY_BASE_DELAY: Duration = Duration::from_millis(300);
/// Socket timeout for esplora HTTP requests. Without it a stalled connection
/// hangs an entire sync cycle indefinitely.
const ESPLORA_TIMEOUT_SECS: u64 = 30;

pub struct EsploraBlockchain {
    client: esplora_client::AsyncClient,
}

impl EsploraBlockchain {
    pub fn new(url: &str) -> Result<Self, esplora_client::Error> {
        let client = esplora_client::Builder::new(url)
            .timeout(ESPLORA_TIMEOUT_SECS)
            .build_async_with_sleeper()?;
        Ok(Self { client })
    }
}

/// Whether an esplora error is a transport-level failure worth retrying.
///
/// `Reqwest` covers connection resets, incomplete responses, mid-handshake TLS
/// aborts and sporadic DNS failures — rampant on hostile mobile networks and
/// almost always gone on the next attempt. `HttpResponse` is deliberately
/// excluded: esplora-client already retries 429/500/503 internally, and other
/// status codes are not transient.
fn is_transient_esplora_error(e: &esplora_client::Error) -> bool {
    matches!(e, esplora_client::Error::Reqwest(_))
}

/// Retry an idempotent async operation while `is_transient` keeps returning
/// true, up to `max_attempts` total, with exponential backoff from `base_delay`.
async fn retry_transient<T, E, F, Fut>(
    max_attempts: usize,
    base_delay: Duration,
    is_transient: impl Fn(&E) -> bool,
    mut op: F,
) -> Result<T, E>
where
    E: std::fmt::Display,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut attempt = 1usize;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(e) if attempt < max_attempts && is_transient(&e) => {
                let delay = base_delay * 2u32.pow((attempt - 1) as u32);
                tracing::debug!(attempt, %e, "transient esplora error; retrying after {delay:?}");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// [`retry_transient`] specialized for esplora reads. Never use this for
/// `broadcast`: a lost response on an already-accepted submission would re-POST
/// the transaction and surface a spurious "already known" error.
async fn esplora_retry<T, F, Fut>(op: F) -> Result<T, esplora_client::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, esplora_client::Error>>,
{
    retry_transient(
        ESPLORA_MAX_ATTEMPTS,
        ESPLORA_RETRY_BASE_DELAY,
        is_transient_esplora_error,
        op,
    )
    .await
}

impl Blockchain for EsploraBlockchain {
    async fn find_outpoints(&self, address: &Address) -> Result<Vec<ExplorerUtxo>, Error> {
        let script_pubkey = address.script_pubkey();
        let txs = esplora_retry(|| self.client.scripthash_txs(&script_pubkey, None))
            .await
            .map_err(Error::consumer)?;

        let candidates: Vec<ExplorerUtxo> = txs
            .into_iter()
            .flat_map(|tx| {
                let txid = tx.txid;
                let block_time = tx.status.block_time;
                tx.vout
                    .into_iter()
                    .enumerate()
                    .filter(|(_, v)| v.scriptpubkey == script_pubkey)
                    .map(move |(i, v)| ExplorerUtxo {
                        outpoint: OutPoint {
                            txid,
                            vout: i as u32,
                        },
                        amount: Amount::from_sat(v.value),
                        confirmation_blocktime: block_time,
                        is_spent: false,
                    })
            })
            .collect();

        let mut utxos = Vec::with_capacity(candidates.len());
        for output in candidates {
            let status = esplora_retry(|| {
                self.client
                    .get_output_status(&output.outpoint.txid, output.outpoint.vout as u64)
            })
            .await
            .map_err(Error::consumer)?;

            utxos.push(match status {
                Some(OutputStatus { spent: true, .. }) => ExplorerUtxo {
                    is_spent: true,
                    ..output
                },
                _ => output,
            });
        }

        Ok(utxos)
    }

    async fn find_tx(&self, txid: &Txid) -> Result<Option<Transaction>, Error> {
        esplora_retry(|| self.client.get_tx(txid))
            .await
            .map_err(Error::consumer)
    }

    async fn get_tx_status(&self, txid: &Txid) -> Result<TxStatus, Error> {
        let info = esplora_retry(|| self.client.get_tx_info(txid))
            .await
            .map_err(Error::consumer)?;

        Ok(TxStatus {
            confirmed_at: info.and_then(|s| s.status.block_time.map(|t| t as i64)),
        })
    }

    async fn get_output_status(&self, txid: &Txid, vout: u32) -> Result<SpendStatus, Error> {
        let status = esplora_retry(|| self.client.get_output_status(txid, vout as u64))
            .await
            .map_err(Error::consumer)?;

        Ok(SpendStatus {
            spend_txid: status.as_ref().and_then(|s| s.txid),
        })
    }

    async fn broadcast(&self, tx: &Transaction) -> Result<(), Error> {
        self.client.broadcast(tx).await.map_err(Error::consumer)
    }

    async fn get_fee_rate(&self) -> Result<f64, Error> {
        let estimates = esplora_retry(|| self.client.get_fee_estimates())
            .await
            .map_err(Error::consumer)?;
        // Target ~6 blocks confirmation, fall back to 1.0 sat/vB
        Ok(estimates.get(&6).copied().unwrap_or(1.0))
    }

    /// Broadcasts transactions sequentially. **Not atomic**: Esplora has no
    /// package-submission endpoint, so if a later broadcast fails the earlier
    /// transactions will already be on the network. In Ark's VTXO tree this is
    /// acceptable because each child transaction spends an output of its parent,
    /// so partial broadcast cannot strand funds — unbroadcast children simply
    /// leave the parent's output unspent and claimable.
    async fn broadcast_package(&self, txs: &[&Transaction]) -> Result<(), Error> {
        for tx in txs {
            self.client.broadcast(tx).await.map_err(Error::consumer)?;
        }
        Ok(())
    }
}

// -- Persistence impl (file-backed boarding outputs) --

const BOARDING_KEYS_ENTRY: &str = "boarding-secret-keys";

#[derive(Clone, Serialize, Deserialize)]
struct BoardingRecord {
    server: bitcoin::XOnlyPublicKey,
    owner: bitcoin::XOnlyPublicKey,
    exit_delay: u32,
}

/// Serializable map of owner public key → secret key.
#[derive(Default, Serialize, Deserialize)]
struct BoardingKeys(
    std::collections::HashMap<bitcoin::XOnlyPublicKey, bitcoin::secp256k1::SecretKey>,
);

/// Abstraction over secret key storage so production code uses the cross-platform
/// `SecureStorage` and tests use an in-memory store.
trait KeyStore: Send + Sync {
    fn load_keys(&self) -> Result<BoardingKeys, Error>;
    fn save_keys(&self, keys: &BoardingKeys) -> Result<(), Error>;
}

/// Production key store backed by [`crate::secure_storage::SecureStorage`]
/// (OS keychain on desktop/iOS, EncryptedSharedPreferences on Android).
struct PlatformKeyStore(crate::secure_storage::SecureStorage);

impl KeyStore for PlatformKeyStore {
    fn load_keys(&self) -> Result<BoardingKeys, Error> {
        match self.0.get(BOARDING_KEYS_ENTRY) {
            Ok(Some(mut json)) => {
                let keys = serde_json::from_str(&json);
                json.zeroize();
                keys.map_err(|e| {
                    Error::consumer(format!("bad boarding keys in secure storage: {e}"))
                })
            }
            Ok(None) => Ok(BoardingKeys::default()),
            Err(e) => Err(Error::consumer(format!("secure storage read error: {e}"))),
        }
    }

    fn save_keys(&self, keys: &BoardingKeys) -> Result<(), Error> {
        let mut json = serde_json::to_string(keys)
            .map_err(|e| Error::consumer(format!("serialize error: {e}")))?;
        let result = self
            .0
            .set(BOARDING_KEYS_ENTRY, &json)
            .map_err(|e| Error::consumer(format!("secure storage write error: {e}")));
        json.zeroize();
        result
    }
}

/// In-memory state: the reconstructed `BoardingOutput` paired with its
/// on-disk record and secret key.
struct BoardingEntry {
    record: BoardingRecord,
    secret_key: bitcoin::secp256k1::SecretKey,
    output: ark_core::BoardingOutput,
}

/// File-backed storage for boarding outputs. Public data is persisted to a
/// JSON file; secret keys are stored via a [`KeyStore`] (OS keychain in
/// production).
pub struct FileDb {
    path: PathBuf,
    /// The ASP server public key. All boarding outputs for a wallet share the
    /// same server, so we store it once and use it when serializing new entries.
    server_pk: bitcoin::XOnlyPublicKey,
    key_store: Box<dyn KeyStore>,
    entries: RwLock<Vec<BoardingEntry>>,
}

impl FileDb {
    /// Load existing boarding outputs from `path` and secret keys from secure
    /// storage, or start empty if neither exists.
    /// Entries are reconstructed via `BoardingOutput::new`.
    pub fn load(
        path: PathBuf,
        network: bitcoin::Network,
        server_pk: bitcoin::XOnlyPublicKey,
        secure_storage: crate::secure_storage::SecureStorage,
    ) -> Result<Self, Error> {
        Self::load_with_key_store(
            path,
            network,
            server_pk,
            Box::new(PlatformKeyStore(secure_storage)),
        )
    }

    fn load_with_key_store(
        path: PathBuf,
        network: bitcoin::Network,
        server_pk: bitcoin::XOnlyPublicKey,
        key_store: Box<dyn KeyStore>,
    ) -> Result<Self, Error> {
        let keys = key_store.load_keys()?;

        let entries = match std::fs::read_to_string(&path) {
            Ok(data) => {
                let records: Vec<BoardingRecord> = serde_json::from_str(&data)
                    .map_err(|e| Error::consumer(format!("bad boarding db: {e}")))?;
                let secp = bitcoin::key::Secp256k1::verification_only();
                let mut entries = Vec::with_capacity(records.len());
                for r in records {
                    let sk = keys.0.get(&r.owner).copied().ok_or_else(|| {
                        Error::consumer(format!(
                            "missing secret key in secure storage for boarding output owner {}",
                            r.owner
                        ))
                    })?;
                    let output = ark_core::BoardingOutput::new(
                        &secp,
                        r.server,
                        r.owner,
                        bitcoin::Sequence(r.exit_delay),
                        network,
                    )
                    .map_err(|e| {
                        Error::consumer(format!("failed to reconstruct boarding output: {e}"))
                    })?;
                    entries.push(BoardingEntry {
                        record: r,
                        secret_key: sk,
                        output,
                    });
                }
                entries
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(Error::consumer(format!("failed to read boarding db: {e}"))),
        };
        Ok(Self {
            path,
            server_pk,
            key_store,
            entries: RwLock::new(entries),
        })
    }

    /// Flush public records to disk and secret keys to the key store.
    ///
    /// Write order: secret keys → public records (atomic rename).
    ///
    /// Uses `block_in_place` to yield the async executor thread during
    /// blocking I/O, preventing thread starvation under load.
    fn flush_refs(&self, entries: &[&BoardingEntry]) -> Result<(), Error> {
        tokio::task::block_in_place(|| {
            // 1. Write secret keys first — safe side of any partial failure.
            let keys = BoardingKeys(
                entries
                    .iter()
                    .map(|e| (e.record.owner, e.secret_key))
                    .collect(),
            );
            self.key_store.save_keys(&keys)?;

            // 2. Write public records atomically: tmp file → rename.
            let records: Vec<&BoardingRecord> = entries.iter().map(|e| &e.record).collect();
            let data = serde_json::to_string_pretty(&records)
                .map_err(|e| Error::consumer(format!("serialize error: {e}")))?;
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| Error::consumer(format!("mkdir error: {e}")))?;
            }
            let tmp_path = self.path.with_extension("json.tmp");
            std::fs::write(&tmp_path, &data)
                .map_err(|e| Error::consumer(format!("write error: {e}")))?;
            std::fs::rename(&tmp_path, &self.path)
                .map_err(|e| Error::consumer(format!("rename error: {e}")))
        })
    }
}

impl Persistence for FileDb {
    fn save_boarding_output(
        &self,
        sk: bitcoin::secp256k1::SecretKey,
        boarding_output: ark_core::BoardingOutput,
    ) -> Result<(), Error> {
        let mut guard = self
            .entries
            .write()
            .map_err(|e| Error::consumer(format!("failed to get write lock: {e}")))?;

        // Deduplicate by output equality
        if guard.iter().any(|e| e.output == boarding_output) {
            return Ok(());
        }

        let record = BoardingRecord {
            server: self.server_pk,
            owner: boarding_output.owner_pk(),
            exit_delay: boarding_output.exit_delay().to_consensus_u32(),
        };
        let entry = BoardingEntry {
            record,
            secret_key: sk,
            output: boarding_output,
        };

        // Build a snapshot that includes the new entry, flush it, and only
        // then commit to in-memory state.  This prevents in-memory state
        // from diverging from disk on a flush failure.
        let mut snapshot: Vec<&BoardingEntry> = guard.iter().collect();
        snapshot.push(&entry);
        self.flush_refs(&snapshot)?;

        guard.push(entry);
        Ok(())
    }

    fn load_boarding_outputs(&self) -> Result<Vec<ark_core::BoardingOutput>, Error> {
        Ok(self
            .entries
            .read()
            .map_err(|e| Error::consumer(format!("failed to get read lock: {e}")))?
            .iter()
            .map(|e| e.output.clone())
            .collect())
    }

    fn sk_for_pk(
        &self,
        pk: &bitcoin::XOnlyPublicKey,
    ) -> Result<bitcoin::secp256k1::SecretKey, Error> {
        self.entries
            .read()
            .map_err(|e| Error::consumer(format!("failed to get read lock: {e}")))?
            .iter()
            .find_map(|e| {
                if e.output.owner_pk() == *pk {
                    Some(e.secret_key)
                } else {
                    None
                }
            })
            .ok_or_else(|| Error::consumer(format!("could not find SK for PK {pk}")))
    }
}

pub type ArkWallet = ark_bdk_wallet::Wallet<FileDb>;
pub type ArkClient = ark_client::Client<
    EsploraBlockchain,
    ArkWallet,
    ark_client::SqliteSwapStorage,
    ark_client::Bip32KeyProvider,
>;

pub fn esplora_url(network: bitcoin::Network, custom: Option<&str>) -> String {
    if let Some(url) = custom {
        if !url.is_empty() {
            return url.to_string();
        }
    }
    match network {
        bitcoin::Network::Bitcoin => "https://blockstream.info/api",
        bitcoin::Network::Testnet => "https://blockstream.info/testnet/api",
        bitcoin::Network::Signet => "https://mutinynet.com/api",
        bitcoin::Network::Regtest => "http://localhost:7070",
        _ => "https://blockstream.info/api",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_client::wallet::Persistence;
    use bitcoin::key::Secp256k1;
    use bitcoin::secp256k1::SecretKey;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// In-memory key store for tests — avoids OS keychain prompts.
    struct MemKeyStore(Mutex<BoardingKeys>);

    impl MemKeyStore {
        fn new() -> Self {
            Self(Mutex::new(BoardingKeys::default()))
        }
    }

    impl KeyStore for MemKeyStore {
        fn load_keys(&self) -> Result<BoardingKeys, Error> {
            Ok(BoardingKeys(self.0.lock().unwrap().0.clone()))
        }

        fn save_keys(&self, keys: &BoardingKeys) -> Result<(), Error> {
            *self.0.lock().unwrap() = BoardingKeys(keys.0.clone());
            Ok(())
        }
    }

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// Create a test FileDb in a unique temp directory with deterministic keys
    /// and an in-memory key store.
    fn test_db() -> Result<(FileDb, bitcoin::XOnlyPublicKey, SecretKey), Box<dyn std::error::Error>>
    {
        let secp = Secp256k1::new();
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("avark-test-{}-{}", std::process::id(), id));
        let path = dir.join("boarding.json");

        let server_sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )?;
        let server_kp = bitcoin::secp256k1::Keypair::from_secret_key(&secp, &server_sk);
        let (server_pk, _) = server_kp.x_only_public_key();

        let owner_sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000002",
        )?;

        let db = FileDb::load_with_key_store(
            path,
            bitcoin::Network::Regtest,
            server_pk,
            Box::new(MemKeyStore::new()),
        )?;
        Ok((db, server_pk, owner_sk))
    }

    /// Reload a FileDb from the same path, using a shared key store.
    fn test_db_with_store(
        path: PathBuf,
        server_pk: bitcoin::XOnlyPublicKey,
        store: std::sync::Arc<MemKeyStore>,
    ) -> Result<FileDb, Box<dyn std::error::Error>> {
        // Wrap the Arc in a newtype that implements KeyStore by delegating.
        struct ArcStore(std::sync::Arc<MemKeyStore>);
        impl KeyStore for ArcStore {
            fn load_keys(&self) -> Result<BoardingKeys, Error> {
                self.0.load_keys()
            }
            fn save_keys(&self, keys: &BoardingKeys) -> Result<(), Error> {
                self.0.save_keys(keys)
            }
        }
        Ok(FileDb::load_with_key_store(
            path,
            bitcoin::Network::Regtest,
            server_pk,
            Box::new(ArcStore(store)),
        )?)
    }

    fn make_boarding_output(
        server_pk: bitcoin::XOnlyPublicKey,
        owner_sk: &SecretKey,
    ) -> Result<ark_core::BoardingOutput, Box<dyn std::error::Error>> {
        let secp = Secp256k1::new();
        let kp = bitcoin::secp256k1::Keypair::from_secret_key(&secp, owner_sk);
        let (owner_pk, _) = kp.x_only_public_key();
        Ok(ark_core::BoardingOutput::new(
            &secp,
            server_pk,
            owner_pk,
            bitcoin::Sequence(512),
            bitcoin::Network::Regtest,
        )?)
    }

    #[test]
    fn save_and_load_boarding_output() -> TestResult {
        let (db, server_pk, owner_sk) = test_db()?;
        let bo = make_boarding_output(server_pk, &owner_sk)?;

        db.save_boarding_output(owner_sk, bo.clone())?;

        let loaded = db.load_boarding_outputs()?;
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], bo);

        let recovered_sk = db.sk_for_pk(&bo.owner_pk())?;
        assert_eq!(recovered_sk, owner_sk);
        Ok(())
    }

    #[test]
    fn persists_across_reloads() -> TestResult {
        let secp = Secp256k1::new();
        let server_sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )?;
        let (server_pk, _) =
            bitcoin::secp256k1::Keypair::from_secret_key(&secp, &server_sk).x_only_public_key();
        let owner_sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000002",
        )?;

        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("avark-test-{}-{}", std::process::id(), id));
        let path = dir.join("boarding.json");

        // Shared key store that survives across FileDb instances.
        let store = std::sync::Arc::new(MemKeyStore::new());
        let db = test_db_with_store(path.clone(), server_pk, store.clone())?;
        let bo = make_boarding_output(server_pk, &owner_sk)?;

        db.save_boarding_output(owner_sk, bo.clone())?;
        drop(db);

        // Reload from same path + same key store
        let db2 = test_db_with_store(path.clone(), server_pk, store)?;
        let loaded = db2.load_boarding_outputs()?;
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], bo);

        let recovered_sk = db2.sk_for_pk(&bo.owner_pk())?;
        assert_eq!(recovered_sk, owner_sk);

        let _ = std::fs::remove_file(&path);
        Ok(())
    }

    #[test]
    fn deduplicates_same_output() -> TestResult {
        let (db, server_pk, owner_sk) = test_db()?;
        let bo = make_boarding_output(server_pk, &owner_sk)?;

        db.save_boarding_output(owner_sk, bo.clone())?;
        db.save_boarding_output(owner_sk, bo)?;

        let loaded = db.load_boarding_outputs()?;
        assert_eq!(loaded.len(), 1);

        let _ = std::fs::remove_file(&db.path);
        Ok(())
    }

    #[test]
    fn load_nonexistent_file_returns_empty() -> TestResult {
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("avark-test-empty-{}.json", id));
        let _ = std::fs::remove_file(&path);
        let secp = Secp256k1::new();
        let sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )?;
        let (pk, _) = bitcoin::secp256k1::Keypair::from_secret_key(&secp, &sk).x_only_public_key();

        let db = FileDb::load_with_key_store(
            path,
            bitcoin::Network::Regtest,
            pk,
            Box::new(MemKeyStore::new()),
        )?;
        assert!(db.load_boarding_outputs()?.is_empty());
        Ok(())
    }

    /// Key store that fails on save — used to verify that in-memory state
    /// is not modified when flush fails.
    struct FailingKeyStore;

    impl KeyStore for FailingKeyStore {
        fn load_keys(&self) -> Result<BoardingKeys, Error> {
            Ok(BoardingKeys::default())
        }
        fn save_keys(&self, _keys: &BoardingKeys) -> Result<(), Error> {
            Err(Error::consumer("simulated key store failure"))
        }
    }

    #[test]
    fn failed_flush_does_not_modify_in_memory_state() -> TestResult {
        let secp = Secp256k1::new();
        let server_sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )?;
        let (server_pk, _) =
            bitcoin::secp256k1::Keypair::from_secret_key(&secp, &server_sk).x_only_public_key();
        let owner_sk = SecretKey::from_str(
            "0000000000000000000000000000000000000000000000000000000000000002",
        )?;

        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("avark-test-{}-{}", std::process::id(), id));
        let path = path.join("boarding.json");

        let db = FileDb::load_with_key_store(
            path,
            bitcoin::Network::Regtest,
            server_pk,
            Box::new(FailingKeyStore),
        )?;
        let bo = make_boarding_output(server_pk, &owner_sk)?;

        // save should fail because the key store rejects writes
        let result = db.save_boarding_output(owner_sk, bo);
        assert!(result.is_err());

        // in-memory state must remain empty
        assert!(db.load_boarding_outputs()?.is_empty());
        Ok(())
    }

    #[test]
    fn esplora_url_matches_network() {
        assert!(esplora_url(bitcoin::Network::Bitcoin, None).contains("blockstream.info/api"));
        assert!(esplora_url(bitcoin::Network::Testnet, None).contains("testnet"));
        assert!(esplora_url(bitcoin::Network::Signet, None).contains("mutinynet"));
        assert!(esplora_url(bitcoin::Network::Regtest, None).starts_with("http://localhost"));
    }

    #[test]
    fn esplora_url_custom_overrides_default() {
        let custom = "https://my-esplora.example.com/api";
        assert_eq!(esplora_url(bitcoin::Network::Bitcoin, Some(custom)), custom);
    }

    #[test]
    fn esplora_url_empty_custom_uses_default() {
        assert!(esplora_url(bitcoin::Network::Bitcoin, Some("")).contains("blockstream.info"));
    }

    #[test]
    fn http_response_errors_are_not_transient() {
        // esplora-client already retries 429/500/503 internally — re-retrying
        // here would just double the load. Other status codes aren't transient.
        let e = esplora_client::Error::HttpResponse {
            status: 503,
            message: "service unavailable".into(),
        };
        assert!(!is_transient_esplora_error(&e));
    }

    #[tokio::test]
    async fn retry_transient_succeeds_without_retrying() {
        let attempts = std::cell::Cell::new(0);
        let result: Result<&str, String> = retry_transient(
            3,
            Duration::ZERO,
            |_| true,
            || {
                attempts.set(attempts.get() + 1);
                async { Ok("ok") }
            },
        )
        .await;
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(attempts.get(), 1, "a first-try success must not retry");
    }

    #[tokio::test]
    async fn retry_transient_recovers_after_transient_failures() {
        let attempts = std::cell::Cell::new(0);
        let result: Result<&str, String> = retry_transient(
            3,
            Duration::ZERO,
            |_| true,
            || {
                let n = attempts.get() + 1;
                attempts.set(n);
                async move {
                    if n < 3 {
                        Err(format!("transient {n}"))
                    } else {
                        Ok("recovered")
                    }
                }
            },
        )
        .await;
        assert_eq!(result.unwrap(), "recovered");
        assert_eq!(attempts.get(), 3);
    }

    #[tokio::test]
    async fn retry_transient_stops_at_max_attempts() {
        let attempts = std::cell::Cell::new(0);
        let result: Result<&str, String> = retry_transient(
            3,
            Duration::ZERO,
            |_| true,
            || {
                let n = attempts.get() + 1;
                attempts.set(n);
                async move { Err(format!("fail {n}")) }
            },
        )
        .await;
        assert_eq!(result.unwrap_err(), "fail 3");
        assert_eq!(attempts.get(), 3, "must give up after max_attempts");
    }

    #[tokio::test]
    async fn retry_transient_does_not_retry_non_transient_errors() {
        let attempts = std::cell::Cell::new(0);
        let result: Result<&str, String> = retry_transient(
            3,
            Duration::ZERO,
            |_| false,
            || {
                attempts.set(attempts.get() + 1);
                async { Err("permanent".to_string()) }
            },
        )
        .await;
        assert_eq!(result.unwrap_err(), "permanent");
        assert_eq!(attempts.get(), 1, "non-transient errors fail immediately");
    }
}
