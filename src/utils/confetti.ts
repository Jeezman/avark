const PARTICLE_COUNT = 80;
const COLORS = ['#bef264', '#fbbf24', '#f87171', '#60a5fa', '#a78bfa', '#34d399', '#fb923c', '#e879f9'];
const GRAVITY = 0.0025;
const DURATION = 3000;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  rotation: number;
  rotationSpeed: number;
  shape: 'rect' | 'circle' | 'strip';
}

export function launchConfetti(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const { width, height } = rect;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const shapes: Particle['shape'][] = ['rect', 'circle', 'strip'];

  const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => {
    const angle = (Math.random() * Math.PI * 2);
    const speed = Math.random() * 7 + 3;
    return {
      x: width / 2 + (Math.random() - 0.5) * 40,
      y: height * 0.3,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: Math.random() * 5 + 3,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 15,
      shape: shapes[Math.floor(Math.random() * shapes.length)],
    };
  });

  const start = performance.now();

  function frame(now: number) {
    const elapsed = now - start;
    if (elapsed > DURATION) {
      ctx!.clearRect(0, 0, width, height);
      return;
    }

    const fade = elapsed > DURATION * 0.6
      ? Math.max(0, 1 - (elapsed - DURATION * 0.6) / (DURATION * 0.4))
      : 1;

    ctx!.clearRect(0, 0, width, height);

    for (const p of particles) {
      p.x += p.vx;
      p.vy += GRAVITY * 16;
      p.y += p.vy;
      p.rotation += p.rotationSpeed;
      p.vx *= 0.995;

      ctx!.save();
      ctx!.translate(p.x, p.y);
      ctx!.rotate((p.rotation * Math.PI) / 180);
      ctx!.globalAlpha = fade;
      ctx!.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx!.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
      } else if (p.shape === 'circle') {
        ctx!.beginPath();
        ctx!.arc(0, 0, p.size * 0.4, 0, Math.PI * 2);
        ctx!.fill();
      } else {
        ctx!.fillRect(-p.size * 0.15, -p.size, p.size * 0.3, p.size * 2);
      }

      ctx!.restore();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
