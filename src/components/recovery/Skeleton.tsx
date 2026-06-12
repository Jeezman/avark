export function Skeleton({
  className,
  delay,
}: {
  className?: string;
  delay?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={`theme-card-elevated rounded animate-pulse ${className ?? ""}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    />
  );
}

export function PreflightSkeleton() {
  return (
    <section
      className="rounded-2xl theme-card p-4 mb-4"
      aria-busy="true"
      aria-label="Loading pre-flight"
    >
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-5 w-14 rounded-full" delay={80} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" delay={120} />
          <Skeleton className="h-4 w-20" delay={160} />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-16" delay={140} />
          <Skeleton className="h-4 w-8" delay={180} />
        </div>
      </div>
    </section>
  );
}

export function BranchesSkeleton() {
  return (
    <section className="space-y-3" aria-busy="true" aria-label="Loading recovery branches">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-2xl theme-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-20" delay={i * 90} />
            <Skeleton className="h-3 w-24" delay={i * 90 + 40} />
          </div>
          <Skeleton className="h-1.5 w-full" delay={i * 90 + 80} />
          <Skeleton className="h-3 w-48" delay={i * 90 + 120} />
          <Skeleton className="h-10 w-full rounded-xl" delay={i * 90 + 160} />
        </div>
      ))}
    </section>
  );
}

export function SweepSkeleton() {
  return (
    <section className="mt-5" aria-busy="true" aria-label="Loading awaiting-sweep VTXOs">
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-20" delay={60} />
      </div>
      <div className="space-y-1.5 mb-3">
        <Skeleton className="h-3 w-full" delay={120} />
        <Skeleton className="h-3 w-5/6" delay={160} />
      </div>
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-2xl theme-card p-4 space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <Skeleton className="h-4 w-24" delay={200 + i * 90} />
              <Skeleton className="h-5 w-20 rounded-full" delay={240 + i * 90} />
            </div>
            <Skeleton className="h-3 w-40" delay={280 + i * 90} />
          </div>
        ))}
      </div>
    </section>
  );
}
