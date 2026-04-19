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
          <div className="relative w-full aspect-square rounded-2xl overflow-hidden bg-black">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              playsInline
              muted
            />
          </div>
          <p className="text-xs theme-text-muted">
            Point camera at a QR code
          </p>
          <button
            onClick={onClose}
            className="rounded-xl theme-card-elevated px-6 py-2.5 text-sm font-medium theme-text hover:opacity-80 transition-colors"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

export default QrScannerView;
