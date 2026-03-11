use bip39::Mnemonic;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::key::Secp256k1;
use bitcoin::Network;
use serde::Serialize;
use zeroize::Zeroize;

#[allow(dead_code)]
/// BIP-86 Taproot derivation path: m/86'/{coin}'/{account}'/0/{index}
///
/// - `account`: hardened account index (0, 1, 2, …)
/// - `index`: address index within the account's external chain
pub fn bip86_path(network: Network, account: u32, index: u32) -> DerivationPath {
    let coin = match network {
        Network::Bitcoin => 0,
        _ => 1,
    };
    format!("m/86'/{coin}'/{account}'/0/{index}")
        .parse()
        .expect("valid derivation path")
}

#[derive(Debug, thiserror::Error)]
pub enum WalletError {
    #[error("Invalid mnemonic: {0}")]
    Mnemonic(#[from] bip39::Error),
    #[error("Key derivation failed: {0}")]
    Derivation(#[from] bitcoin::bip32::Error),
}

impl Serialize for WalletError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// A mnemonic wrapper that zeroizes its backing string on drop
/// and redacts its content in Debug output.
///
/// Note: `bip39::Mnemonic` doesn't implement `Zeroize`, so we zeroize the
/// `words` string (the human-readable secret) and the seed bytes we derive.
/// The `Mnemonic` struct itself is opaque and dropped normally.
pub struct SecretMnemonic {
    words: String,
    mnemonic: Mnemonic,
}

impl Drop for SecretMnemonic {
    fn drop(&mut self) {
        self.words.zeroize();
    }
}

impl std::fmt::Debug for SecretMnemonic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED mnemonic]")
    }
}

impl SecretMnemonic {
    pub fn mnemonic(&self) -> &Mnemonic {
        &self.mnemonic
    }

    pub fn words(&self) -> &str {
        &self.words
    }
}

/// Generate a new random BIP39 mnemonic (12 words).
pub fn generate_mnemonic() -> Result<SecretMnemonic, WalletError> {
    let mnemonic = Mnemonic::generate(12)?;
    let words = mnemonic.to_string();
    Ok(SecretMnemonic { words, mnemonic })
}

/// Parse and validate a BIP39 mnemonic string.
///
/// Accepts 12- or 24-word mnemonics only. The checksum is verified by the
/// `bip39` crate; this function additionally rejects non-standard word counts
/// that BIP39 technically allows (15, 18, 21) but that Avark does not support.
pub fn parse_mnemonic(words: &str) -> Result<SecretMnemonic, WalletError> {
    let word_count = words.split_whitespace().count();
    if word_count != 12 && word_count != 24 {
        return Err(WalletError::Mnemonic(bip39::Error::BadWordCount(
            word_count,
        )));
    }
    let mnemonic = Mnemonic::parse_normalized(words.trim())?;
    let words = mnemonic.to_string();
    Ok(SecretMnemonic { words, mnemonic })
}

/// Derive the network-specific master extended private key from mnemonic words.
pub fn derive_master_xpriv(words: &str, network: Network) -> Result<Xpriv, WalletError> {
    let secret = parse_mnemonic(words)?;
    derive_master_xpriv_from_secret(&secret, network)
}

/// Derive the master extended private key from an already-parsed [`SecretMnemonic`],
/// avoiding a redundant string copy when the caller already holds one.
pub fn derive_master_xpriv_from_secret(
    secret: &SecretMnemonic,
    network: Network,
) -> Result<Xpriv, WalletError> {
    let mut seed = secret.mnemonic().to_seed("");
    let xpriv = Xpriv::new_master(network, &seed)?;
    seed.zeroize();
    Ok(xpriv)
}

#[allow(dead_code)]
/// Derive an extended private key at a specific BIP-32 derivation path.
///
/// Uses an empty BIP39 passphrase (the spec-default). This is intentional:
/// most wallets omit the passphrase, and it keeps seed derivation compatible
/// with standard tooling. If passphrase support is added later, this function
/// signature should gain a `passphrase: &str` parameter.
pub fn derive_xpriv(
    mnemonic: &SecretMnemonic,
    network: Network,
    path: &DerivationPath,
) -> Result<Xpriv, WalletError> {
    let secp = Secp256k1::signing_only();
    let mut seed = mnemonic.mnemonic().to_seed("");
    let master = Xpriv::new_master(network, &seed)?;
    seed.zeroize();
    let derived = master.derive_priv(&secp, path)?;
    Ok(derived)
}

#[allow(dead_code)]
/// Derive a secp256k1 keypair at a specific BIP-32 derivation path.
pub fn derive_keypair(
    mnemonic: &SecretMnemonic,
    network: Network,
    path: &DerivationPath,
) -> Result<bitcoin::key::Keypair, WalletError> {
    let secp = Secp256k1::signing_only();
    let xpriv = derive_xpriv(mnemonic, network, path)?;
    Ok(bitcoin::key::Keypair::from_secret_key(
        &secp,
        &xpriv.private_key,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_mnemonic_produces_12_words() {
        let secret = generate_mnemonic().unwrap();
        assert_eq!(secret.mnemonic().word_count(), 12);
    }

    #[test]
    fn parse_valid_mnemonic_succeeds() {
        let secret = generate_mnemonic().unwrap();
        let words = secret.words().to_owned();
        let parsed = parse_mnemonic(&words).expect("should parse valid mnemonic");
        assert_eq!(parsed.words(), words);
    }

    #[test]
    fn parse_invalid_mnemonic_fails() {
        let result = parse_mnemonic("invalid words that are not a real mnemonic phrase at all");
        assert!(result.is_err());
    }

    #[test]
    fn derive_master_xpriv_is_stable_for_same_words() {
        let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let first = derive_master_xpriv(words, Network::Bitcoin).expect("should derive master key");
        let second =
            derive_master_xpriv(words, Network::Bitcoin).expect("should derive master key");
        assert_eq!(first, second);
    }

    #[test]
    fn derive_master_xpriv_trims_whitespace() {
        let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let padded = "  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about  ";
        let clean =
            derive_master_xpriv(words, Network::Bitcoin).expect("should derive clean master key");
        let trimmed = derive_master_xpriv(padded, Network::Bitcoin)
            .expect("should ignore surrounding whitespace");
        assert_eq!(clean, trimmed);
    }

    #[test]
    fn derive_master_xpriv_changes_across_networks() {
        let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let bitcoin =
            derive_master_xpriv(words, Network::Bitcoin).expect("should derive bitcoin master key");
        let testnet =
            derive_master_xpriv(words, Network::Testnet).expect("should derive testnet master key");
        assert_ne!(bitcoin, testnet);
    }

    #[test]
    fn debug_output_is_redacted() {
        let secret = generate_mnemonic().unwrap();
        let debug = format!("{:?}", secret);
        assert_eq!(debug, "[REDACTED mnemonic]");
        assert!(!debug.contains(secret.words()));
    }

    #[test]
    fn derive_keypair_produces_valid_pubkey() {
        let secret = generate_mnemonic().unwrap();
        let path = bip86_path(Network::Bitcoin, 0, 0);
        let keypair = derive_keypair(&secret, Network::Bitcoin, &path).unwrap();
        assert_eq!(keypair.public_key().serialize().len(), 33);
    }

    #[test]
    fn same_mnemonic_produces_same_keypair() {
        let secret = generate_mnemonic().unwrap();
        let path = bip86_path(Network::Bitcoin, 0, 0);
        let kp1 = derive_keypair(&secret, Network::Bitcoin, &path).unwrap();
        let kp2 = derive_keypair(&secret, Network::Bitcoin, &path).unwrap();
        assert_eq!(kp1.public_key(), kp2.public_key());
    }

    #[test]
    fn different_accounts_produce_different_keys() {
        let secret = generate_mnemonic().unwrap();
        let acct0 = bip86_path(Network::Bitcoin, 0, 0);
        let acct1 = bip86_path(Network::Bitcoin, 1, 0);
        let kp0 = derive_keypair(&secret, Network::Bitcoin, &acct0).unwrap();
        let kp1 = derive_keypair(&secret, Network::Bitcoin, &acct1).unwrap();
        assert_ne!(kp0.public_key(), kp1.public_key());
    }

    #[test]
    fn different_indexes_produce_different_keys() {
        let secret = generate_mnemonic().unwrap();
        let idx0 = bip86_path(Network::Bitcoin, 0, 0);
        let idx1 = bip86_path(Network::Bitcoin, 0, 1);
        let kp0 = derive_keypair(&secret, Network::Bitcoin, &idx0).unwrap();
        let kp1 = derive_keypair(&secret, Network::Bitcoin, &idx1).unwrap();
        assert_ne!(kp0.public_key(), kp1.public_key());
    }

    #[test]
    fn different_networks_produce_different_keys() {
        let secret = generate_mnemonic().unwrap();
        let mainnet = bip86_path(Network::Bitcoin, 0, 0);
        let testnet = bip86_path(Network::Testnet, 0, 0);
        let kp_main = derive_keypair(&secret, Network::Bitcoin, &mainnet).unwrap();
        let kp_test = derive_keypair(&secret, Network::Testnet, &testnet).unwrap();
        assert_ne!(kp_main.public_key(), kp_test.public_key());
    }
}
