#![allow(unused_imports)]

pub mod relays;

pub use nostr_sdk::{Keys as Keypair, Metadata, PublicKey, ToBech32};

/// Secure-storage key for the user's Nostr private key (bech32 `nsec...`).
pub const NSEC_KEY: &str = "nostr_nsec";
