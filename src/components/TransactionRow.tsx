import { formatSats, formatDate } from "../utils/format";

const KIND_LABELS: Record<string, string> = {
  boarding: "Boarding",
  commitment: "Round",
  ark: "Ark Transfer",
  offboard: "Offboard",
};

export function txKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

interface TransactionRowProps {
  kind: string;
  amount_sat: number;
  created_at: number | null;
  is_settled: boolean | null;
  statusLabel?: string | null;
  statusType?: "confirmed" | "pending" | "failed";
}

export function TransactionRow({
  kind,
  amount_sat,
  created_at,
  is_settled,
  statusLabel,
  statusType,
}: TransactionRowProps) {
  const label = KIND_LABELS[kind] ?? kind;
  const pending = statusLabel ?? (is_settled === false ? "Pending" : null);
  const isFailed = statusType === "failed";

  return (
    <div className="flex items-center justify-between rounded-xl theme-card px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {pending && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                isFailed
                  ? "theme-danger-bg theme-danger"
                  : "theme-warning-bg theme-warning"
              }`}
            >
              {pending}
            </span>
          )}
        </div>
        <p className="text-xs theme-text-muted mt-0.5">
          {formatDate(created_at)}
        </p>
      </div>
      <p
        className={`text-sm font-semibold tabular-nums ${
          isFailed
            ? "theme-negative"
            : amount_sat >= 0
              ? "theme-positive"
              : "theme-negative"
        }`}
      >
        {amount_sat >= 0 ? "+" : ""}
        {formatSats(amount_sat)}{" "}
        <span className="text-[10px] theme-text-faint">sats</span>
      </p>
    </div>
  );
}
