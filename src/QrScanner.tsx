import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

interface QrScannerViewProps {
  onScan: (result: string) => void;
  onClose: () => void;
}

function QrScannerView({ onScan, onClose }: QrScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let active = true;
    let scanner: QrScanner | null = null;
    const startPromise = Promise.resolve().then(async () => {
      if (!active || !video) return;
      const s = new QrScanner(
        video,
        (result) => {
          if (result.data) onScanRef.current(result.data);
        },
        {
          preferredCamera: 'environment',
          highlightScanRegion: true,
          highlightCodeOutline: true,
          maxScansPerSecond: 15,
          calculateScanRegion: (v) => ({
            x: 0,
            y: 0,
            width: v.videoWidth || v.clientWidth,
            height: v.videoHeight || v.clientHeight,
          }),
        },
      );
      s.setInversionMode('both');
      try {
        await s.start();
        if (!active) {
          s.stop();
          s.destroy();
          return;
        }
        scanner = s;
      } catch (err) {
        s.destroy();
        if (!active) return;
        setError(
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'Camera access denied',
        );
      }
    });

    return () => {
      active = false;
      void startPromise.then(() => {
        scanner?.stop();
        scanner?.destroy();
      });
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      {error ? (
        <div className="rounded-2xl theme-danger-bg p-6 text-center">
          <p className="text-sm theme-danger mb-3">{error}</p>
          <button
            onClick={onClose}
            className="rounded-xl theme-card-elevated px-4 py-2 text-sm font-medium theme-text hover:opacity-80 transition-colors"
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <div className="relative w-full aspect-square overflow-hidden rounded-3xl bg-black">
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              playsInline
              autoPlay
              muted
              controls={false}
              disablePictureInPicture
              onPlaying={() => setReady(true)}
            />

            {/* Silent black cover until the first camera frame — guards against
                the native video poster/play button without a visible spinner. */}
            {!ready && <div className="absolute inset-0 bg-black" />}

            {/* Scan-frame guides */}
            {ready && (
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute inset-0 bg-black/20" />
                <div className="absolute left-1/2 top-1/2 h-[62%] w-[62%] -translate-x-1/2 -translate-y-1/2">
                  {(
                    [
                      'left-0 top-0 border-l-2 border-t-2 rounded-tl-xl',
                      'right-0 top-0 border-r-2 border-t-2 rounded-tr-xl',
                      'left-0 bottom-0 border-l-2 border-b-2 rounded-bl-xl',
                      'right-0 bottom-0 border-r-2 border-b-2 rounded-br-xl',
                    ] as const
                  ).map((pos) => (
                    <span
                      key={pos}
                      className={`absolute h-7 w-7 ${pos}`}
                      style={{ borderColor: '#bef264' }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <p className="text-xs theme-text-muted">
            {ready ? 'Point your camera at a QR code' : 'Allow camera access to scan'}
          </p>
          <button
            onClick={onClose}
            className="rounded-xl theme-card-elevated px-6 py-2.5 text-sm font-medium theme-text transition-colors hover:opacity-80"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

export default QrScannerView;
