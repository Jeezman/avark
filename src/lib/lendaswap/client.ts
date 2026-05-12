/**
 * TS-SDK-based LendaSwap integration for avark.
 *
 *
 *   1. Lazily builds a singleton `Client` on first call. The SDK is seeded
 *      with a LendaSwap-purpose extended private key (xprv) derived Rust-side
 *      via the `get_lendaswap_xprv`. The SDK's `withXprv(...)` is documented as ephemeral — the
 *      xprv is never written to IndexedDB — so a WebView compromise can drain
 *      LendaSwap-purpose keys but not the user's main BTC funds.
 *   2. Exposes thin wrappers around the SDK's `getQuote`, `createSwap`,
 *      `getSwap`, and `claim`, so every call point has one import path.
 *   3. Mirrors SDK state into avark's `lendaswap_swaps` table via the Rust
 *      DB-only commands (`insert_lendaswap_swap`, `update_lendaswap_swap_status`).
 *      Rust owns history + resume-after-restart; the SDK owns network + HD keys.
 */

import {
  Client,
  IdbSwapStorage,
  IdbWalletStorage,
  type Chain,
  type QuoteResponse,
  type TokenInfos,
  type TokenInfo,
  type ClaimResult,
} from "@lendasat/lendaswap-sdk-pure";
import { invoke } from "@tauri-apps/api/core";

/**
 * Target tokens we expose in v1. Keeping this explicit so the UI doesn't
 * have to filter the full token list — we know exactly which two we ship.
 * Chain IDs + token identifiers are looked up dynamically via `getTokens()`
 * so we don't hardcode contract addresses; if LendaSwap changes them or
 * adds more tokens, the lookup still works.
 */
export const SUPPORTED_TARGETS = ["usdc_eth", "usdt_eth"] as const;
export type TargetTokenId = (typeof SUPPORTED_TARGETS)[number];

/**
 * The set of `status` values considered terminal — polling and reconcile
 * should stop, history shows a final-state pill, no further server-side
 * transition is expected.
 *
 * **Mirrored in Rust:** `TERMINAL_STATUSES` in `src-tauri/src/lendaswap.rs`
 * and the `CHECK(status IN (…))` constraint on `lendaswap_swaps` list the
 * same values. Keep all three in sync until codegen replaces this comment.
 */
export const TERMINAL_SWAP_STATUSES = [
  "completed",
  "failed",
  "expired",
  "refunded",
] as const;

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_SWAP_STATUSES);

export function isTerminalSwapStatus(status: string): boolean {
  return TERMINAL_SET.has(status);
}

function lookupTarget(id: TargetTokenId, tokens: TokenInfos): TokenInfo {
  const symbol = id === "usdc_eth" ? "USDC" : "USDT";
  const match = tokens.evm_tokens.find(
    (t) => t.symbol === symbol && String(t.chain) === "1",
  );
  if (!match) {
    throw new Error(
      `LendaSwap tokens list has no ${symbol} on Ethereum mainnet — ` +
        "the SDK's backend may have rotated the supported set. Check `getTokens()`.",
    );
  }
  return match;
}

function lookupBtcLightning(tokens: TokenInfos): TokenInfo {
  const match = tokens.btc_tokens.find((t) => t.chain === "Lightning");
  if (!match) {
    throw new Error(
      "LendaSwap tokens list has no BTC on Lightning — this would indicate " +
        "a major API change upstream.",
    );
  }
  return match;
}

// ─── client singleton ─────────────────────────────────────────────────────

let clientPromise: Promise<Client> | null = null;

// Bumping this re-runs the IDB purge on next app start. Useful if a future
// SDK upgrade introduces a new DB name we also need to wipe.
const IDB_PURGE_FLAG_KEY = "avark_lendaswap_idb_purged_v1";

/**
 * One-shot wipe of any LendaSwap IndexedDB databases left over from the
 * pre-pivot architecture, which used `withMnemonic(...)` and persisted the
 * wallet's BIP39 mnemonic into `lendaswap-v3` (and migrated from an even
 * older `lendaswap-v2`). With the xprv-only flow there is nothing sensitive
 * to keep, and any stored mnemonic must be scrubbed.
 *
 * Idempotent via a localStorage flag — runs at most once per install.
 */
async function purgeLegacyLendaswapIdb(): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof localStorage === "undefined") {
    return;
  }
  if (localStorage.getItem(IDB_PURGE_FLAG_KEY) === "true") return;

  const results = await Promise.all([
    deleteIdb("lendaswap-v3"),
    deleteIdb("lendaswap-v2"),
  ]);
  // Only flag-as-done when every deletion succeeded (or was a no-op because
  // the DB didn't exist). On error we leave the flag unset so the next app
  // start retries — better than silently leaving legacy state behind.
  if (results.every(Boolean)) {
    localStorage.setItem(IDB_PURGE_FLAG_KEY, "true");
  }
}

function deleteIdb(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    // `blocked` fires when another tab/window holds the DB open. The
    // deletion is queued and will complete when the holder closes — so we
    // treat this as success rather than retrying every cold start.
    req.onblocked = () => {
      console.warn(`[lendaswap] IDB delete blocked for ${name}`);
      resolve(true);
    };
    req.onerror = () => {
      console.warn(`[lendaswap] IDB delete failed for ${name}`, req.error);
      resolve(false);
    };
    req.onsuccess = () => resolve(true);
  });
}

async function buildClient(): Promise<Client> {
  await purgeLegacyLendaswapIdb();
  const xprv = await invoke<string>("get_lendaswap_xprv");
  return Client.builder()
    .withSignerStorage(new IdbWalletStorage())
    .withSwapStorage(new IdbSwapStorage())
    .withXprv(xprv)
    .build();
}

/**
 * Get the cached SDK client. Builds on first call; reuses afterward.
 * Callers don't need to await mnemonic fetch themselves.
 *
 * On failure (e.g. `get_lendaswap_xprv` rejecting because the wallet isn't
 * unlocked yet, or a transient network error during build) the cached
 * promise is cleared so the next caller retries from scratch — otherwise a
 * single cold-boot rejection would poison the singleton until app restart.
 */
export function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = buildClient().catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

/**
 * Drop the cached client. Called when the wallet is deleted/reset so a new
 * wallet's mnemonic is used on next call.
 */
export function resetClient(): void {
  clientPromise = null;
}

// ─── tokens (cached) ──────────────────────────────────────────────────────

let tokensCache: TokenInfos | null = null;

export async function getTokens(): Promise<TokenInfos> {
  if (tokensCache) return tokensCache;
  const client = await getClient();
  tokensCache = await client.getTokens();
  return tokensCache;
}

// ─── quote ────────────────────────────────────────────────────────────────

/**
 * Avark's UI-friendly rate shape, built from the SDK's `QuoteResponse` plus
 * the token metadata so the caller doesn't have to look things up twice.
 */
export interface AvarkQuote {
  /** Human-readable target amount with decimals applied (e.g. "77.45") */
  targetAmount: string;
  sourceAmountSats: number;
  targetToken: TargetTokenId;
  networkFee: number;
  protocolFee: number;
  serviceFee: number;
  minAmountSats: number;
  maxAmountSats: number;
  /** Synthesized client-side to match the UI's countdown cadence (no server ttl exposed). */
  expiresAt: number;
}

const QUOTE_TTL_SECS = 30;

export async function getQuote(
  targetToken: TargetTokenId,
  amountSats: number,
): Promise<AvarkQuote> {
  const client = await getClient();
  const tokens = await getTokens();
  const btc = lookupBtcLightning(tokens);
  const target = lookupTarget(targetToken, tokens);

  const quote: QuoteResponse = await client.getQuote({
    sourceChain: btc.chain,
    sourceToken: btc.token_id,
    targetChain: target.chain,
    targetToken: target.token_id,
    sourceAmount: amountSats,
  });

  // target_amount is in base units (e.g. USDC has 6 decimals → 77_451_379
  // means 77.451379 USDC). Scale down before handing to the UI.
  const targetDecimals = target.decimals;
  const scaled = scaleDown(quote.target_amount, targetDecimals);

  return {
    targetAmount: scaled,
    sourceAmountSats: amountSats,
    targetToken,
    networkFee: quote.network_fee,
    protocolFee: quote.protocol_fee,
    // LendaSwap doesn't emit a separate service fee — keep 0 to preserve the
    // three-line fee breakdown in the UI.
    serviceFee: 0,
    minAmountSats: quote.min_amount,
    maxAmountSats: quote.max_amount,
    expiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECS,
  };
}

/** Scale an integer string in token base units down by `decimals` places. */
function scaleDown(value: string | number, decimals: number): string {
  const raw = typeof value === "string" ? value : String(value);
  const digits = raw.replace(/^0+/, "") || "0";
  if (decimals <= 0) return digits;
  if (digits.length <= decimals) {
    return `0.${digits.padStart(decimals, "0").replace(/0+$/, "") || "0"}`;
  }
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

// ─── create swap ──────────────────────────────────────────────────────────

/**
 * Avark's `lendaswap_swaps` row after a successful creation. The frontend
 * passes this shape back to the router so the checkout deep-link
 * (`/swap/checkout/$id`) works immediately.
 */
export interface AvarkSwapRecord {
  id: string;
  lendaswap_id: string;
  direction: string;
  source_amount_sats: number;
  target_token: string;
  target_amount: string;
  destination_address: string;
  ln_invoice: string;
  network_fee: number;
  protocol_fee: number;
  service_fee: number;
  status: string;
  claim_tx_hash: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export async function createSwap(params: {
  targetToken: TargetTokenId;
  amountSats: number;
  targetAddress: string;
  /** Pre-fetched quote so the persisted fees match what the user saw. */
  quote: AvarkQuote;
}): Promise<AvarkSwapRecord> {
  const client = await getClient();
  const tokens = await getTokens();
  const target = lookupTarget(params.targetToken, tokens);

  const result = await client.createLightningToEvmSwapGeneric({
    targetAddress: params.targetAddress,
    evmChainId: 1,
    tokenAddress: target.token_id,
    amountIn: params.amountSats,
  });

  // `LightningToEvmSwapResponse` has flat `id`, `status`, and a
  // `bolt11_invoice` / `boltz_invoice` (deprecated alias) for the invoice.
  // `boltz_swap_id` lets us pre-flight Boltz-Arkade's view of the reverse
  // swap — see `preflightBoltz` below. Wrapped in a minimal shape read so
  // we don't depend on field names that might be renamed in a later SDK
  // release.
  const response = result.response as {
    id: string;
    status: string;
    bolt11_invoice?: string;
    boltz_invoice?: string;
    boltz_swap_id?: string;
  };

  // Boltz-Arkade pre-flight: LendaSwap returns a swap response regardless of
  // whether Boltz successfully set up the underlying reverse submarine swap.
  // When Boltz fails (e.g. "onchain coins could not be sent") the hold
  // invoice on its LND node is never armed, so every subsequent LN payment
  // attempt will fail with `INCORRECT_PAYMENT_DETAILS`. Rather than let the user stare at a dead invoice,
  // we probe Boltz's status endpoint for a few seconds and fail fast.
  if (response.boltz_swap_id) {
    const health = await preflightBoltz(response.boltz_swap_id);
    if (!health.ok) {
      const reason = health.failureReason ?? health.status ?? "unknown";
      throw new Error(
        `LendaSwap's Lightning bridge is currently unavailable (Boltz-Arkade: ${reason}). ` +
          "Your sats have NOT been charged. Try again in a few minutes or use a different swap route.",
      );
    }
  }

  const lendaswapId = response.id;
  const lnInvoice = response.bolt11_invoice ?? response.boltz_invoice ?? "";
  const status = mapSdkStatus(response.status);
  const localId = crypto.randomUUID();

  return invoke<AvarkSwapRecord>("insert_lendaswap_swap", {
    params: {
      id: localId,
      lendaswapId,
      sourceAmountSats: params.amountSats,
      targetToken: params.targetToken,
      targetAmount: params.quote.targetAmount,
      destinationAddress: params.targetAddress,
      lnInvoice,
      networkFee: params.quote.networkFee,
      protocolFee: params.quote.protocolFee,
      serviceFee: params.quote.serviceFee,
      status,
    },
  });
}

// ─── Boltz-Arkade pre-flight ──────────────────────────────────────────────

const BOLTZ_ARKADE_URL = "https://api.ark.boltz.exchange";
/** Statuses that mean Boltz has given up — no point letting the user try to pay. */
const BOLTZ_BAD_STATUSES = new Set([
  "transaction.failed",
  "invoice.failedToPay",
  "invoice.expired",
  "swap.expired",
]);
/**
 * Statuses that prove the reverse swap is actually set up on Boltz's side:
 * the hold invoice is armed (`invoice.set`) or the swap has already advanced
 * past that point. Seeing one of these means the user can safely pay.
 *
 * `swap.created` is NOT in this set — it's the initial record Boltz makes
 * the instant a swap is requested, before they've tried to lock the VTXO.
 * The "onchain coins could not be sent" failure we observed transitions
 * from `swap.created → transaction.failed` after a few seconds, so treating
 * `swap.created` as "healthy" lets dead swaps through. Keep polling past it.
 */
const BOLTZ_OK_STATUSES = new Set([
  "invoice.set",
  "transaction.mempool",
  "transaction.confirmed",
  "invoice.pending",
  "invoice.paid",
]);
// Initial / transient states (e.g. `swap.created`) aren't enumerated — they
// fall through the unknown-status branch below and the poll retries.
//
// 45s gives Boltz-Arkade plenty of breathing room. Slow ASP responses can
// stretch the "swap.created" phase significantly.
const PREFLIGHT_DEADLINE_MS = 45_000;
const PREFLIGHT_INTERVAL_MS = 1_500;

interface BoltzStatusResponse {
  status?: string;
  failureReason?: string;
}

async function preflightBoltz(
  boltzSwapId: string,
): Promise<{ ok: boolean; status?: string; failureReason?: string }> {
  const start = Date.now();
  let lastStatus: string | undefined;
  let polls = 0;

  console.info(
    `[lendaswap/preflight] starting Boltz-Arkade health check for ${boltzSwapId}`,
  );

  while (Date.now() - start < PREFLIGHT_DEADLINE_MS) {
    polls += 1;
    try {
      const r = await fetch(`${BOLTZ_ARKADE_URL}/v2/swap/${boltzSwapId}`);
      if (r.ok) {
        const body = (await r.json()) as BoltzStatusResponse;
        lastStatus = body.status;
        console.info(
          `[lendaswap/preflight] poll #${polls} → status=${body.status ?? "(none)"}${
            body.failureReason ? ` failureReason=${body.failureReason}` : ""
          }`,
        );
        if (body.status && BOLTZ_BAD_STATUSES.has(body.status)) {
          console.warn(
            `[lendaswap/preflight] Boltz reports unhealthy status ${body.status} for ${boltzSwapId} — rejecting swap`,
          );
          return {
            ok: false,
            status: body.status,
            failureReason: body.failureReason,
          };
        }
        if (body.status && BOLTZ_OK_STATUSES.has(body.status)) {
          console.info(
            `[lendaswap/preflight] Boltz reports healthy status ${body.status} for ${boltzSwapId} — proceeding`,
          );
          return { ok: true, status: body.status };
        }
        // Unknown status — fall through to retry.
      } else {
        console.info(
          `[lendaswap/preflight] poll #${polls} → HTTP ${r.status} (retrying)`,
        );
      }
    } catch (e) {
      console.info(`[lendaswap/preflight] poll #${polls} → fetch threw: ${e}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_INTERVAL_MS));
  }

  // Timed out on a transient status (like `swap.created`) or network errors.
  // Proceed optimistically; downstream surfaces (BoltzInFlight panel, /recover/ln)
  // already handle the fallout if the swap later fails. We no longer hard-reject
  // `swap.created` because slow ASPs can keep it in that state for >30s.
  console.warn(
    `[lendaswap/preflight] timed out after ${polls} polls (lastStatus=${lastStatus ?? "(none)"}) — proceeding optimistically`,
  );
  return { ok: true, status: lastStatus ?? "preflight-timeout" };
}

// ─── status refresh ───────────────────────────────────────────────────────

export async function refreshSwap(
  localId: string,
  lendaswapId: string,
): Promise<AvarkSwapRecord> {
  const client = await getClient();
  // `GetSwapResponse` is a tagged union whose variants have different shapes.
  // For Lightning→EVM (our v1 direction), `id` and `status` are top-level
  // fields; `evm_claim_txid` is the new field name with `evm_htlc_claim_txid`
  // as a legacy alias on older responses. Read via a narrowed shape so we
  // don't depend on the union's variant narrowing, which gets noisy.
  const resp = (await client.getSwap(lendaswapId, { updateStorage: true })) as {
    id: string;
    status: string;
    evm_claim_txid?: string | null;
    evm_htlc_claim_txid?: string | null;
  };
  const status = mapSdkStatus(resp.status);
  const claimTxHash = resp.evm_claim_txid ?? resp.evm_htlc_claim_txid ?? null;

  return invoke<AvarkSwapRecord>("update_lendaswap_swap_status", {
    params: {
      id: localId,
      status,
      claimTxHash,
    },
  });
}

// ─── claim ────────────────────────────────────────────────────────────────

export async function claim(
  localId: string,
  lendaswapId: string,
): Promise<{ txHash?: string; message: string }> {
  const client = await getClient();
  const result: ClaimResult = await client.claim(lendaswapId);
  if (!result.success) {
    throw new Error(result.message);
  }
  // Persist whatever txHash the gasless claim returned immediately so
  // the UI has something to render before the next refresh cycle.
  if (result.txHash) {
    await invoke<AvarkSwapRecord>("update_lendaswap_swap_status", {
      params: {
        id: localId,
        // Status stays "processing" until the next refresh confirms the tx;
        // we only capture the hash here.
        status: "processing",
        claimTxHash: result.txHash,
      },
    });
  }
  return { txHash: result.txHash, message: result.message };
}

// ─── status mapping ───────────────────────────────────────────────────────

/**
 * Collapse the SDK's fine-grained status vocabulary to avark's 7 canonical
 * strings (enforced by the SQLite CHECK constraint). Mirrors the old
 * Rust `map_sdk_status` we deleted during the pivot.
 */
function mapSdkStatus(sdk: string): string {
  switch (sdk) {
    case "pending":
    case "Pending":
      return "awaiting_payment";
    case "client_funding_seen":
    case "ClientFundingSeen":
    case "client_funded":
    case "ClientFunded":
    case "server_funded":
    case "ServerFunded":
    case "client_redeeming":
    case "ClientRedeeming":
      return "processing";
    case "client_redeemed":
    case "ClientRedeemed":
    case "server_redeemed":
    case "ServerRedeemed":
    case "client_redeemed_and_client_refunded":
    case "ClientRedeemedAndClientRefunded":
      return "completed";
    case "client_refunded":
    case "ClientRefunded":
    case "client_funded_server_refunded":
    case "ClientFundedServerRefunded":
    case "client_refunded_server_funded":
    case "ClientRefundedServerFunded":
    case "client_refunded_server_refunded":
    case "ClientRefundedServerRefunded":
      return "refunded";
    case "expired":
    case "Expired":
      return "expired";
    case "client_invalid_funded":
    case "ClientInvalidFunded":
    case "client_funded_too_late":
    case "ClientFundedTooLate":
      return "failed";
    default:
      // Unknown status — log + treat as processing so the UI doesn't hide
      // the swap. Adjust this fallback if a new terminal status shows up.
      console.warn(`[lendaswap] unknown SDK status: ${sdk}, treating as processing`);
      return "processing";
  }
}

export type { Chain };
