# Avark Privacy Policy

**App Covered:** Avark
**Developer:** Tobi Adeyemi
**Privacy Contact:** <useavark@protonmail.com>
**Last Updated: 2026-06-24**

## Our Commitment to Privacy

Avark is a self-custodial Bitcoin wallet for the Ark protocol, built with privacy
as a core principle. Your keys, your funds, and your financial data stay on your
device and under your control. We do not run servers that collect your data, and
we have no way to see your balances, transactions, or recovery phrase.

## Information We Collect

**None.** Avark does not collect, store, or transmit any personal information to
the developer.

- We do **not** use analytics or user-behavior tracking.
- We do **not** use crash- or error-reporting services (no Sentry, Firebase,
  Crashlytics, or similar).
- We do **not** operate any backend that receives your wallet data.
- There are no accounts, sign-ups, names, or email addresses.

## Information We Don't Collect

- **No personal data** — no name, email, phone number, or contacts.
- **No financial data** — we never receive your balances, transaction history,
  addresses, invoices, private keys, or recovery phrase.
- **No analytics or behavioral tracking** of how you use the app.
- **No third-party advertising or tracking SDKs.**

## Local Data Storage

- Your wallet — including your recovery phrase and private keys — is stored
  **only on your device**, protected by your device's secure storage (the
  Android Keystore / iOS Keychain).
- All other wallet state (settings, cached data, transaction history) is kept
  locally on your device.
- This data is **never transmitted to the developer**. If you uninstall the app
  or wipe its data without backing up your recovery phrase, your funds cannot be
  recovered by us.

## Third-Party Services Your Wallet Connects To

Like any Bitcoin or Ark wallet, Avark must talk to network services to function.
These are independent providers, not operated by the developer. When the app
contacts them, they can observe your device's **IP address** and the information
inherently required to provide the service (for example, the addresses or
invoices being looked up). They cannot access your private keys or recovery
phrase. Where possible, the relevant endpoints are **configurable in Settings**,
so you can point the app at providers you trust or your own infrastructure.

- **Ark Service Provider (ASP)** — coordinates Ark transactions and rounds.
  Default: `arkade.computer` (configurable).
- **Bitcoin block explorer (Esplora)** — reads on-chain data and broadcasts
  transactions. Default: `blockstream.info` (mainnet) / `mutinynet.com`
  (signet), configurable.
- **Boltz** — used only when you send or receive via Lightning, to perform a
  submarine swap (`api.ark.boltz.exchange`).
- **WalletConnect** — used only when you connect to a third-party dApp; relays
  the connection between your wallet and that app.
- **LendaSwap** — used only when you initiate a swap through that feature.
- **Package-broadcast endpoint** (optional) — used only for the emergency
  on-chain exit flow, to broadcast a transaction package; configurable.

Each of these has its own privacy practices, which are outside our control.
Please review their respective policies.

## The Bitcoin and Ark Networks

By design, Bitcoin transactions are recorded on a public blockchain, and Ark
transactions are processed through the public Ark protocol network that operates
on top of Bitcoin. Information published to these networks is inherently public.
This is a property of the underlying technology, not data collected by Avark.

## App Permissions

- **Camera** — used solely to scan QR codes (addresses and invoices). Images are
  processed on-device and never stored or transmitted by the app.
- **Network/Internet** — required to communicate with the services listed above.

## Information Collected by App Stores

While we do not collect data ourselves, the platforms that distribute the app may
collect limited information as part of their standard distribution service:

- **Google Play Store** — may collect basic app usage statistics and crash
  reports.
- **Apple App Store / TestFlight** — may collect basic app usage statistics and
  crash reports.

This collection is controlled by Google and Apple, not by Avark. Please refer to
their privacy policies for details.

## Children's Privacy

Avark is not directed at children and is intended for users who are of legal age
to manage their own finances. We do not knowingly collect information from
children.

## Changes to This Policy

We may update this policy from time to time. Material changes will be reflected by
updating the "Last Updated" date above and publishing the revised policy at this
location.

## Contact

Questions about this policy can be sent to: <useavark@protonmail.com>

---

_This policy reflects our commitment to user privacy: a self-custodial wallet
that keeps your keys and your data on your device, and collects nothing._
