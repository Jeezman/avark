import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  BranchesSkeleton,
  PreflightSkeleton,
  Skeleton,
  SweepSkeleton,
} from "../components/recovery/Skeleton";
import { SweepForm, type UnrolledVtxoMaturity } from "../components/recovery/SweepForm";
import { formatCountdown, formatSats, shortTxid } from "../utils/format";

interface PreflightStatus {
  ready: boolean;
  blockers: string[];
  onchainBalanceSat: number;
  onchainPendingSat: number;
  onchainAddress: string | null;
}

interface ExitTxStatus {
  txid: string;
  confirmedAt: number | null;
}

interface ExitBranchStatus {
  branchIndex: number;
  txs: ExitTxStatus[];
  nextPendingIndex: number | null;
  sourceOutpoint: string | null;
  sourceAmountSat: number | null;
}

interface UnilateralExitStatus {
  branches: ExitBranchStatus[];
}

interface ExitSweepStatus {
  csvDelaySeconds: number;
  now: number;
  dustSat: number;
  vtxos: UnrolledVtxoMaturity[];
}

interface BroadcastOutcome {
  parentTxid: string;
  anchorTxid: string | null;
  feeSat: number;
  alreadyPublished: boolean;
  dryRun: boolean;
}

const POLL_INTERVAL_MS = 30_000;

function disabledHint(pf: PreflightStatus | null, busy: boolean): string | null {
  if (busy || !pf || pf.ready) return null;
  if (pf.onchainBalanceSat === 0) {
    if (pf.onchainPendingSat > 0) {
      return "Waiting for your pending onchain change to confirm (~1 block).";
    }
    return "Send plain-onchain sats to the address above to enable.";
  }
  return "Resolve the pre-flight blockers above to enable.";
}

function formatExitDelay(secs: number): string {
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = secs / 3600;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

async function shareAddress(address: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Plain onchain address", text: address });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    }
  }
  try {
    await invoke("share_text", { text: address });
  } catch {
    toast.error("Failed to share");
  }
}

export function RecoveryRoute() {
  const [preflight, setPreflight] = useState<PreflightStatus | null>(null);
  const [status, setStatus] = useState<UnilateralExitStatus | null>(null);
  const [sweep, setSweep] = useState<ExitSweepStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [sweepLoading, setSweepLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<{
    branchIndex: number;
    outcome: BroadcastOutcome;
  } | null>(null);
  const cancelledRef = useRef(false);

  const loadAll = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    setLoadError(null);

    try {
      const pf = await invoke<PreflightStatus>("unilateral_exit_preflight");
      if (cancelledRef.current) return;
      setPreflight(pf);
    } catch (e) {
      if (cancelledRef.current) return;
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      setLoadError(msg);
      if (showLoading) setLoading(false);
      else setRefreshing(false);
      setStatusLoading(false);
      setSweepLoading(false);
      return;
    }

    if (!cancelledRef.current) {
      if (showLoading) setLoading(false);
      else setRefreshing(false);
    }

    setStatusLoading(true);
    setSweepLoading(true);

    const statusPromise = invoke<UnilateralExitStatus>("unilateral_exit_status")
      .then((st) => {
        if (cancelledRef.current) return;
        setStatus(st);
      })
      .catch((e) => {
        if (cancelledRef.current) return;
        const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
        console.warn("unilateral_exit_status failed:", msg);
      })
      .finally(() => {
        if (!cancelledRef.current) setStatusLoading(false);
      });

    const sweepPromise = invoke<ExitSweepStatus>("unilateral_exit_sweep_status")
      .then((sw) => {
        if (cancelledRef.current) return;
        setSweep(sw);
      })
      .catch((e) => {
        if (cancelledRef.current) return;
        const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
        console.warn("unilateral_exit_sweep_status failed:", msg);
      })
      .finally(() => {
        if (!cancelledRef.current) setSweepLoading(false);
      });

    await Promise.allSettled([statusPromise, sweepPromise]);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void loadAll(true);
    const interval = setInterval(() => void loadAll(false), POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [loadAll]);

  async function onPrepareBroadcast(branchIndex: number) {
    setActionBusy(branchIndex);
    setConfirmation(null);
    try {
      const outcome = await invoke<BroadcastOutcome>("unilateral_exit_broadcast_next", {
        branchIndex,
        dryRun: true,
      });
      if (outcome.alreadyPublished) {
        toast.info("Every transaction in this branch is already on-chain.");
        await loadAll(false);
        return;
      }
      setConfirmation({ branchIndex, outcome });
    } catch (e) {
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      toast.error(msg);
    } finally {
      setActionBusy(null);
    }
  }

  async function onConfirmBroadcast() {
    if (!confirmation) return;
    const { branchIndex } = confirmation;
    setActionBusy(branchIndex);
    setConfirmation(null);
    try {
      const outcome = await invoke<BroadcastOutcome>("unilateral_exit_broadcast_next", {
        branchIndex,
        dryRun: false,
      });
      if (outcome.alreadyPublished) {
        toast.info("Already on-chain — nothing was broadcast.");
      } else {
        toast.success(
          `Broadcast ${shortTxid(outcome.parentTxid)} (anchor ${shortTxid(
            outcome.anchorTxid ?? "",
          )}, ${formatSats(outcome.feeSat)} sats fee).`,
        );
      }
      await loadAll(false);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      toast.error(msg);
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div
      className="theme-text flex flex-col min-h-[calc(100dvh-3.5rem)] px-5 pb-10"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.25rem)" }}
    >
      <header className="flex items-center gap-3 mb-5">
        <Link
          to="/settings"
          aria-label="Back to settings"
          title="Back"
          className="rounded-full theme-card-elevated p-2 active:scale-95 transition-transform"
        >
          ←
        </Link>
        <h1 className="flex-1 text-2xl font-bold">Emergency exit</h1>
        <button
          aria-label="Refresh now"
          title="Refresh now"
          onClick={() => void loadAll(false)}
          disabled={refreshing || loading || statusLoading || sweepLoading}
          className="rounded-full theme-card-elevated p-2 active:scale-95 transition-transform disabled:opacity-50"
        >
          <svg
            className={`h-4 w-4 ${
              refreshing || statusLoading || sweepLoading ? "animate-spin" : ""
            }`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </header>

      <p className="text-sm theme-text-muted mb-4">
        Broadcasts your cached unilateral-exit tree to Bitcoin without the ASP. Each
        transaction is fee-bumped from your onchain balance; you must wait for each to
        confirm before broadcasting the next. After every tx in a branch confirms, the
        VTXO is on-chain — sweeping it to a regular address is a separate flow that
        opens after the exit-delay (CSV) elapses.
      </p>

      {loading && (
        <>
          <PreflightSkeleton />
          <BranchesSkeleton />
          <SweepSkeleton />
          <span className="sr-only" aria-live="polite">
            Loading recovery state
          </span>
        </>
      )}

      {loadError && !loading && (
        <div className="rounded-2xl theme-warning-bg theme-warning border theme-warning-border p-4 text-sm">
          Couldn't load recovery state: {loadError}
        </div>
      )}

      {!loading && preflight && (
        <section className="rounded-2xl theme-card p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold theme-text">Pre-flight</p>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                preflight.ready ? "theme-accent-bg" : "theme-warning-bg theme-warning"
              }`}
            >
              {preflight.ready ? "Ready" : "Blocked"}
            </span>
          </div>
          {preflight.blockers.length > 0 && (
            <ul className="space-y-1.5 mb-3">
              {preflight.blockers.map((b, i) => (
                <li
                  key={i}
                  className="rounded-xl theme-warning-bg px-3 py-2 text-xs theme-warning"
                >
                  {b}
                </li>
              ))}
            </ul>
          )}
          {preflight.onchainBalanceSat === 0 &&
            preflight.onchainPendingSat === 0 &&
            preflight.onchainAddress && (
            <div className="rounded-xl theme-card-elevated p-3 mb-3 space-y-2">
              <p className="text-xs font-semibold theme-text">Plain onchain address</p>
              <p className="text-[11px] theme-text-muted">
                Send any small amount (~5-10k sats) here to fund fee-bumping.
                This is <em>not</em> your boarding address.
              </p>
              <p className="break-all font-mono text-[11px] theme-text">
                {preflight.onchainAddress}
              </p>
              <div className="flex gap-2">
                <button
                  className="flex-1 rounded-lg theme-card px-3 py-1.5 text-xs font-semibold theme-text active:scale-95 transition-transform"
                  onClick={() => {
                    void navigator.clipboard.writeText(preflight.onchainAddress!).then(
                      () => toast.success("Address copied"),
                      () => toast.error("Failed to copy"),
                    );
                  }}
                >
                  Copy
                </button>
                <button
                  className="flex-1 rounded-lg theme-card px-3 py-1.5 text-xs font-semibold theme-text active:scale-95 transition-transform"
                  onClick={() => void shareAddress(preflight.onchainAddress!)}
                >
                  Share
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="theme-text-muted mb-0.5">Onchain available</p>
              <p className="theme-text tabular-nums">
                {formatSats(preflight.onchainBalanceSat)} sats
                {preflight.onchainPendingSat > 0 && (
                  <span className="theme-text-muted">
                    {" · "}
                    {formatSats(preflight.onchainPendingSat)} pending
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="theme-text-muted mb-0.5">Branches</p>
              {status !== null ? (
                <p className="theme-text tabular-nums">{status.branches.length}</p>
              ) : statusLoading ? (
                <Skeleton className="h-4 w-6 mt-0.5" />
              ) : (
                <p
                  className="theme-text-muted tabular-nums"
                  title="Couldn't load branches"
                >
                  —
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {!loading && statusLoading && status === null && <BranchesSkeleton />}

      {!loading && !statusLoading && status === null && (
        <div className="rounded-2xl theme-warning-bg theme-warning border theme-warning-border p-4 text-sm">
          Couldn't load recovery branches. Tap refresh to retry.
        </div>
      )}

      {!loading && status && status.branches.length > 0 && (() => {
        // Multiple VTXOs can descend from the same Ark round commitment, so
        // their exit chains share early-tree virtual txs. Map each pending
        // txid to the branches it's the next-pending for; if more than one
        // branch shares it, broadcasting once advances all of them.
        const sharedNextPending = new Map<string, number[]>();
        for (const b of status.branches) {
          if (b.nextPendingIndex !== null) {
            const txid = b.txs[b.nextPendingIndex].txid;
            const list = sharedNextPending.get(txid) ?? [];
            list.push(b.branchIndex);
            sharedNextPending.set(txid, list);
          }
        }
        return (
        <section className="space-y-3">
          {status.branches.map((branch) => {
            const total = branch.txs.length;
            const confirmed = branch.txs.filter((t) => t.confirmedAt !== null).length;
            const allDone = branch.nextPendingIndex === null;
            const busy = actionBusy === branch.branchIndex;
            const showingConfirm = confirmation?.branchIndex === branch.branchIndex;
            const nextTx =
              branch.nextPendingIndex !== null ? branch.txs[branch.nextPendingIndex] : null;

            return (
              <div key={branch.branchIndex} className="rounded-2xl theme-card p-4 space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold theme-text">
                    Branch {branch.branchIndex + 1}
                    {branch.sourceAmountSat !== null && (
                      <span className="ml-2 font-normal theme-text-muted tabular-nums">
                        · {formatSats(branch.sourceAmountSat)} sats
                      </span>
                    )}
                  </p>
                  <span className="shrink-0 text-xs theme-text-muted tabular-nums">
                    {confirmed} of {total} confirmed
                  </span>
                </div>

                {/* Progress bar */}
                <div className="h-1.5 rounded-full theme-card-elevated overflow-hidden">
                  <div
                    className="h-full bg-lime-300 transition-all"
                    style={{ width: total === 0 ? "0%" : `${(confirmed / total) * 100}%` }}
                  />
                </div>

                {allDone ? (
                  <p className="text-xs theme-accent">
                    All transactions confirmed. Wait for the exit-delay before sweeping.
                  </p>
                ) : (
                  <>
                    <div className="text-xs theme-text-muted">
                      Next pending: <span className="theme-text font-mono">{shortTxid(nextTx!.txid)}</span>
                    </div>

                    {(() => {
                      const sharers = sharedNextPending.get(nextTx!.txid) ?? [];
                      const others = sharers.filter((i) => i !== branch.branchIndex);
                      if (others.length === 0) return null;
                      const labels = others
                        .map((i) => `Branch ${i + 1}`)
                        .join(", ");
                      return (
                        <p className="text-[11px] theme-accent">
                          Broadcasting this also advances {labels}.
                        </p>
                      );
                    })()}

                    {showingConfirm && confirmation && (
                      <div className="rounded-xl theme-warning-bg p-3 space-y-2 text-xs">
                        <p className="font-semibold theme-warning">Confirm broadcast</p>
                        <p className="theme-text">
                          Broadcasts <span className="font-mono">{shortTxid(confirmation.outcome.parentTxid)}</span>{" "}
                          + anchor <span className="font-mono">{shortTxid(confirmation.outcome.anchorTxid ?? "")}</span>.
                        </p>
                        <p className="theme-text">
                          Fee: <span className="font-mono tabular-nums">{formatSats(confirmation.outcome.feeSat)} sats</span> · irrevocable.
                        </p>
                        <div className="flex gap-2 pt-1">
                          <button
                            className="flex-1 rounded-lg theme-card-elevated px-3 py-2 text-xs font-medium"
                            onClick={() => setConfirmation(null)}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                          <button
                            className="flex-1 rounded-lg bg-lime-300 px-3 py-2 text-xs font-bold text-gray-900 active:scale-95 transition-transform disabled:opacity-40"
                            onClick={() => void onConfirmBroadcast()}
                            disabled={busy}
                          >
                            {busy ? "Broadcasting…" : "Broadcast"}
                          </button>
                        </div>
                      </div>
                    )}

                    {!showingConfirm && (() => {
                      const broadcastDisabled = busy || !preflight?.ready;
                      const hint = disabledHint(preflight, busy);
                      return (
                        <div className="space-y-2">
                          <button
                            className={
                              broadcastDisabled
                                ? "w-full rounded-xl theme-card-elevated px-4 py-2.5 text-sm font-semibold theme-text-muted cursor-not-allowed"
                                : "w-full rounded-xl bg-lime-300 px-4 py-2.5 text-sm font-bold text-gray-900 active:scale-95 transition-transform"
                            }
                            onClick={() => void onPrepareBroadcast(branch.branchIndex)}
                            disabled={broadcastDisabled}
                          >
                            {busy ? "Preparing…" : "Broadcast next"}
                          </button>
                          {hint && (
                            <p className="text-center text-xs theme-text-muted">{hint}</p>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            );
          })}
        </section>
        );
      })()}

      {!loading && status && status.branches.length === 0 && preflight?.ready && (
        <div className="rounded-2xl theme-card p-4 text-sm theme-text-muted">
          The recovery package is empty — there is nothing to broadcast.
        </div>
      )}

      {!loading && sweepLoading && sweep === null && <SweepSkeleton />}

      {!loading && sweep && sweep.vtxos.length > 0 && (
        <section className="mt-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold theme-text">Awaiting sweep</h2>
            <span className="text-[11px] theme-text-muted">
              Exit delay: ~{formatExitDelay(sweep.csvDelaySeconds)}
            </span>
          </div>
          <p className="text-xs theme-text-muted mb-3 leading-snug">
            VTXOs you've already broadcast. Each is on-chain but locked by a CSV
            timelock; once a countdown reaches zero, the sweep form below moves
            all unlocked funds to any Bitcoin address in one transaction.
          </p>
          <div className="space-y-3">
            {sweep.vtxos.map((v) => {
              const remaining = v.csvMatureAt !== null ? v.csvMatureAt - sweep.now : null;
              return (
                <div
                  key={`${v.txid}:${v.vout}`}
                  className="rounded-2xl theme-card p-4 space-y-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-semibold theme-text tabular-nums">
                      {formatSats(v.amountSat)} sats
                    </p>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        v.mature ? "theme-accent-bg" : "theme-warning-bg theme-warning"
                      }`}
                    >
                      {v.mature
                        ? "Ready to sweep"
                        : remaining !== null
                          ? `In ${formatCountdown(remaining)}`
                          : "Awaiting confirmation"}
                    </span>
                  </div>
                  <p className="font-mono text-[11px] theme-text-muted">
                    {shortTxid(v.txid)}:{v.vout}
                  </p>
                </div>
              );
            })}
          </div>
          {(() => {
            const mature = sweep.vtxos.filter((v) => v.mature);
            if (mature.length === 0) return null;
            const totalSat = mature.reduce((sum, v) => sum + v.amountSat, 0);
            return (
              <div className="rounded-2xl theme-card p-4 space-y-2 mt-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-semibold theme-text tabular-nums">
                    {formatSats(totalSat)} sats ready
                  </p>
                  <span className="text-[11px] theme-text-muted">
                    {mature.length} output{mature.length > 1 ? "s" : ""}
                  </span>
                </div>
                <SweepForm
                  totalSat={totalSat}
                  dustSat={sweep.dustSat}
                  outputCount={mature.length}
                  onSwept={() => void loadAll(false)}
                />
              </div>
            );
          })()}
        </section>
      )}
    </div>
  );
}
