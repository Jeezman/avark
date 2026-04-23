# Security Policy

Avark is a Bitcoin wallet. A vulnerability in this codebase or its release
pipeline can put user funds directly at risk, so we take reports seriously
and ask researchers to follow responsible disclosure.

## Reporting a Vulnerability

**Please do not report security issues through public GitHub issues,
pull requests, or discussions.**

The preferred channel is **GitHub's private vulnerability reporting**:

> [Report a vulnerability](https://github.com/Jeezman/avark/security/advisories/new)

This keeps the report and all follow-up correspondence private until a
fix is ready, and creates a tracked advisory from the start.

### What to include

- Affected platform(s): Android, iOS, macOS, Windows, or Linux
- Version or commit SHA
- Steps to reproduce
- Impact: what can an attacker achieve, and under what preconditions?
- Suggested fix or mitigation, if you have one

## Response

Avark is a small project, so we can't commit to formal SLAs, but we aim
to:

- Acknowledge receipt within a few days
- Agree a fix and disclosure timeline with you in the advisory thread
- Credit you in release notes once a fix ships, unless you'd prefer to
  stay anonymous

## Disclosure

Coordinated disclosure. Please keep the issue private until a fix has
shipped in a tagged release. If a fix is going to take longer than 90
days, we will reach out to agree a public-disclosure plan together
rather than let the report sit indefinitely.

## Scope

### In scope

- Code in this repository (Rust backend in `src-tauri/`, frontend in
  `src/`, build and release infrastructure under `.github/` and
  `scripts/`)
- Release artifacts published on this repository's Releases page and the
  signing process that produces them
- Documentation that affects user security posture (for example
  `docs/VERIFYING.md`)

### Out of scope — please report upstream

- **Tauri** itself — see <https://github.com/tauri-apps/tauri/security>
- **Arkade / Ark protocol / Ark Service Providers (ASPs)** — see the
  contact information at <https://docs.arkadeos.com>
- **Bitcoin Core**, **rust-bitcoin**, **BDK**, and other third-party
  dependencies — report to the respective upstream project
- Platform-level issues in **Android**, **iOS**, or the underlying OS

### Out of our threat model

These are acknowledged risks we do not treat as vulnerabilities:

- Attacks that assume malware already running with root or admin
  privileges on the user's device
- Physical attacks requiring sustained unsupervised access to an
  unlocked device
- Attacks against ASPs the user has chosen to trust, where the ASP is
  behaving maliciously within its protocol role

## Supported versions

During pre-1.0 development, only the latest released version receives
security fixes. Once the project reaches 1.0, we will document a
longer-term support policy here.

## Verifying releases

Release APKs and desktop bundles are signed, and each release ships a
GPG-signed `SHA256SUMS` file. **Always verify signatures before
installing** — see [docs/VERIFYING.md](docs/VERIFYING.md) for the full
process and the signing-key fingerprint. Running an unverified build
from an unofficial source is not a supported security configuration and
reports based on such builds cannot be meaningfully triaged.
