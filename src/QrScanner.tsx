import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

interface QrScannerViewProps {
  onScan: (result: string) => void;
  onClose: () => void;
}

function QrScannerView({ onScan, onClose }: QrScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let scanTimer: ReturnType<typeof setInterval> | null = null;

    async function startCamera() {
      try {
        // Request camera directly — avoids enumerateDevices() which
        // returns empty on Android WebView until getUserMedia succeeds.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped || !video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();

        // Scan frames periodically using qr-scanner's decoder
        const v = video;
        scanTimer = setInterval(async () => {
          if (stopped || v.readyState < v.HAVE_ENOUGH_DATA) return;
          try {
            const result = await QrScanner.scanImage(v, {
              returnDetailedScanResult: true,
            });
            if (result.data) {
              onScan(result.data);
            }
          } catch {
            // No QR code found in this frame — expected, keep scanning
          }
        }, 200);
      } catch (err) {
        if (!stopped) {
          setError(
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : 'Camera access denied',
          );
        }
      }
    }

    void startCamera();

    return () => {
      stopped = true;
      if (scanTimer) clearInterval(scanTimer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [onScan]);

  return (
    <div className="flex flex-col items-center gap-4">
      {error ? (
        <div className="rounded-2xl bg-red-500/10 p-6 text-center">
          <p className="text-sm text-red-300 mb-3">{error}</p>
          <button
            onClick={onClose}
            className="rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15 transition-colors"
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <div className="relative w-full max-w-[280px] aspect-square rounded-2xl overflow-hidden bg-black">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              playsInline
              muted
            />
          </div>
          <p className="text-xs text-white/40">
            Point camera at a QR code
          </p>
          <button
            onClick={onClose}
            className="rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white hover:bg-white/15 transition-colors"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

export default QrScannerView;
