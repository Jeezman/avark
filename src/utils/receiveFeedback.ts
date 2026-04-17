let audioCtx: AudioContext | null = null;

export function playSuccessSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.value = 523.25; // C5
    osc2.type = 'sine';
    osc2.frequency.value = 659.25; // E5

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.2);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.4);
  } catch {
    // Audio not available
  }
}

export function triggerHaptic() {
  try {
    navigator.vibrate?.(200);
  } catch {
    // Vibration not available
  }
}
