import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface RoundSchedule {
  next_start_time: number | null;
  session_duration: number;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'now';
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

function formatCadence(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/**
 * Shows a live countdown when the ASP publishes `scheduled_session`; falls
 * back to a static "Rounds run every Xm" cadence derived from
 * `session_duration`. Silent if neither field is available.
 */
export function NextRoundCountdown() {
  const [schedule, setSchedule] = useState<RoundSchedule | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  // Dedupe in-flight get_round_schedule calls. Rust's ASP timeout is 10s, and
  // the refresh effect below re-runs every tick once we've passed
  // next_start_time — without this ref we'd stack one RPC per second while a
  // slow/unreachable ASP is still responding to the previous request.
  const inFlightRef = useRef(false);

  // Pause ticking + refreshes while the app is backgrounded.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    async function load() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const s = await invoke<RoundSchedule>('get_round_schedule');
        if (!cancelled) setSchedule(s);
      } catch (err) {
        console.warn('[round] get_round_schedule failed', err);
        if (!cancelled) setSchedule(null);
      } finally {
        inFlightRef.current = false;
      }
    }
    void load();
    setNow(Math.floor(Date.now() / 1000));
    const tick = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [visible]);

  // Refresh when the current next_start_time passes so the countdown reflects
  // the upcoming round rather than sliding negative.
  useEffect(() => {
    if (!visible) return;
    if (!schedule?.next_start_time) return;
    if (now < schedule.next_start_time) return;
    if (inFlightRef.current) return;
    let cancelled = false;
    inFlightRef.current = true;
    (async () => {
      try {
        const s = await invoke<RoundSchedule>('get_round_schedule');
        if (!cancelled) setSchedule(s);
      } catch {
        /* keep stale schedule; countdown will just clamp to "now" */
      } finally {
        inFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, now, schedule]);

  if (!schedule) return null;

  if (schedule.next_start_time) {
    const remaining = schedule.next_start_time - now;
    return (
      <p className="text-[10px] theme-text-faint mt-1">
        Next round in {formatDuration(remaining)}
      </p>
    );
  }

  if (schedule.session_duration > 0) {
    return (
      <p className="text-[10px] theme-text-faint mt-1">
        Rounds run every {formatCadence(schedule.session_duration)}
      </p>
    );
  }

  return null;
}
