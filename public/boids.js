// ════════════════════════════════════════════════
//  BOIDS · Full-screen Reynolds flocking
//  Card avoidance · Cursor parallax · Event triggers
// ════════════════════════════════════════════════

(() => {
  const canvas = document.getElementById("boidsCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");

  // ── config (responsive — recalculated on resize) ──
  let BOID_COUNT, CONNECTION_DIST, RADIUS;
  function recalcConfig() {
    const m = window.innerWidth < 768;
    BOID_COUNT = m ? 40 : 90;
    CONNECTION_DIST = m ? 0 : 100;
    RADIUS = m ? 2.5 : 3;
  }
  recalcConfig();
  const MAX_SPEED = 1.4;
  const MIN_SPEED = 0.6;
  const COHESION_WEIGHT = 0.0016;
  const SEPARATION_WEIGHT = 0.09;
  const ALIGNMENT_WEIGHT = 0.03;
  const SEPARATION_RADIUS = 60;
  const NEIGHBOR_RADIUS = 60;
  const MARGIN = 40;

  // ── state ──
  let W, H;
  let boids = [];
  let animId;
  let cardRect = null;      // bounding rect of .app-window for avoidance
  let mouseX = -1000, mouseY = -1000;  // cursor for parallax

  // Event-triggered forces (decay over time)
  let burstForce = 0;
  let expandForce = 0;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    updateCardRect();
    for (const b of boids) {
      b.x = Math.max(0, Math.min(W, b.x));
      b.y = Math.max(0, Math.min(H, b.y));
    }
  }

  function updateCardRect() {
    const card = document.querySelector(".app-window");
    if (card) {
      cardRect = card.getBoundingClientRect();
    } else {
      cardRect = null;
    }
  }

  function createBoid() {
    const angle = Math.random() * Math.PI * 2;
    const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      colorType: Math.random() < 0.55 ? 'accent' : 'bg',
      trail: [],
    };
  }

  function initBoids() {
    boids = [];
    for (let i = 0; i < BOID_COUNT; i++) {
      boids.push(createBoid());
    }
  }

  // ── card avoidance force (gentle) ──
  // Softly nudge boids away from the glass card so they still spread across
  // the full viewport but don't cluster inside the card.
  function cardAvoidance(b) {
    if (!cardRect) return { fx: 0, fy: 0 };
    const pad = 30;
    const cx = cardRect.left + cardRect.width / 2;
    const cy = cardRect.top + cardRect.height / 2;
    const hw = cardRect.width / 2 + pad;
    const hh = cardRect.height / 2 + pad;

    const dx = Math.max(0, Math.abs(b.x - cx) - hw);
    const dy = Math.max(0, Math.abs(b.y - cy) - hh);
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < pad && dist > 0.01) {
      const nx = (b.x - cx) / (Math.abs(b.x - cx) + 0.001);
      const ny = (b.y - cy) / (Math.abs(b.y - cy) + 0.001);
      const strength = (1 - dist / pad) * 0.06;
      return { fx: nx * strength, fy: ny * strength };
    }
    return { fx: 0, fy: 0 };
  }

  // ── flocking forces ──
  function flock(b) {
    let cx = 0, cy = 0, ax = 0, ay = 0, sx = 0, sy = 0;
    let nCohesion = 0, nAlign = 0;

    for (const other of boids) {
      if (other === b) continue;
      const dx = b.x - other.x;
      const dy = b.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < SEPARATION_RADIUS && dist > 0.01) {
        sx += dx / dist;
        sy += dy / dist;
      }
      if (dist < NEIGHBOR_RADIUS) {
        cx += other.x; cy += other.y; nCohesion++;
        ax += other.vx; ay += other.vy; nAlign++;
      }
    }

    let fx = 0, fy = 0;
    if (nCohesion > 0) {
      cx /= nCohesion; cy /= nCohesion;
      fx += (cx - b.x) * COHESION_WEIGHT;
      fy += (cy - b.y) * COHESION_WEIGHT;
    }
    if (nAlign > 0) {
      ax /= nAlign; ay /= nAlign;
      fx += (ax - b.vx) * ALIGNMENT_WEIGHT;
      fy += (ay - b.vy) * ALIGNMENT_WEIGHT;
    }
    fx += sx * SEPARATION_WEIGHT;
    fy += sy * SEPARATION_WEIGHT;

    // Edge avoidance
    if (b.x < MARGIN) fx += (MARGIN - b.x) * 0.02;
    if (b.x > W - MARGIN) fx -= (b.x - (W - MARGIN)) * 0.02;
    if (b.y < MARGIN) fy += (MARGIN - b.y) * 0.02;
    if (b.y > H - MARGIN) fy -= (b.y - (H - MARGIN)) * 0.02;

    // Card avoidance
    const card = cardAvoidance(b);
    fx += card.fx;
    fy += card.fy;

    // Cursor parallax: subtle attraction when mouse is on screen
    if (mouseX > 0 && mouseY > 0 && mouseX < W && mouseY < H) {
      const mdx = mouseX - b.x;
      const mdy = mouseY - b.y;
      const mdist = Math.sqrt(mdx * mdx + mdy * mdy);
      if (mdist > 10 && mdist < 400) {
        const strength = (1 - mdist / 400) * 0.008;
        fx += (mdx / mdist) * strength;
        fy += (mdy / mdist) * strength;
      }
    }

    // Event triggers
    if (burstForce > 0) {
      const angle = Math.atan2(b.vy, b.vx);
      fx += Math.cos(angle) * burstForce * 0.5;
      fy += Math.sin(angle) * burstForce * 0.5;
    }
    if (expandForce > 0) {
      const dx = b.x - W / 2;
      const dy = b.y - H / 2;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      fx += (dx / d) * expandForce * 0.03;
      fy += (dy / d) * expandForce * 0.03;
    }

    return { fx, fy };
  }

  function update() {
    burstForce *= 0.95;
    expandForce *= 0.95;
    if (burstForce < 0.001) burstForce = 0;
    if (expandForce < 0.001) expandForce = 0;

    for (const b of boids) {
      const { fx, fy } = flock(b);
      b.vx += fx;
      b.vy += fy;
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (spd > 0) {
        const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, spd));
        b.vx = (b.vx / spd) * clamped;
        b.vy = (b.vy / spd) * clamped;
      }
      // Trail: push current position (before moving)
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 6) b.trail.shift();

      b.x += b.vx;
      b.y += b.vy;
      if (b.x < -30) { b.x = W + 30; b.trail = []; }
      if (b.x > W + 30) { b.x = -30; b.trail = []; }
      if (b.y < -30) { b.y = H + 30; b.trail = []; }
      if (b.y > H + 30) { b.y = -30; b.trail = []; }
    }
  }

  // Read current palette colors from CSS for themed boids (cached, refreshed on change)
  let cachedAccentRGB = null;
  let cachedBGRGB = null;

  function refreshColors() {
    const style = getComputedStyle(document.documentElement);
    // ── accent ──
    const aHex = style.getPropertyValue('--accent').trim();
    if (aHex && /^#[0-9a-fA-F]{6}$/.test(aHex)) {
      cachedAccentRGB = `${parseInt(aHex.slice(1,3),16)}, ${parseInt(aHex.slice(3,5),16)}, ${parseInt(aHex.slice(5,7),16)}`;
    } else {
      cachedAccentRGB = "45, 165, 85";
    }
    // ── bg (darken and desaturate for subtle boid tone) ──
    const bgHex = style.getPropertyValue('--bg').trim();
    if (bgHex && /^#[0-9a-fA-F]{6}$/.test(bgHex)) {
      const r = parseInt(bgHex.slice(1,3),16), g = parseInt(bgHex.slice(3,5),16), b = parseInt(bgHex.slice(5,7),16);
      // Darken and blend toward neutral for background boid tone
      const mix = 0.65;
      cachedBGRGB = `${Math.round(r*mix + 20*(1-mix))}, ${Math.round(g*mix + 18*(1-mix))}, ${Math.round(b*mix + 16*(1-mix))}`;
    } else {
      cachedBGRGB = "28, 38, 32"; // fallback dark greenish
    }
  }
  refreshColors();

  const attrObserver = new MutationObserver(refreshColors);
  attrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    const accentAlpha = isDark ? 0.55 : 0.35;
    const bgAlpha = isDark ? 0.35 : 0.22;

    for (const b of boids) {
      const isAccent = b.colorType === 'accent';
      const color = isAccent ? cachedAccentRGB : cachedBGRGB;
      const baseAlpha = isAccent ? accentAlpha : bgAlpha;

      // ── trail: fading dots behind the boid ──
      const trailLen = b.trail.length;
      if (trailLen > 0) {
        const trailBaseAlpha = baseAlpha * 0.22;
        for (let t = 0; t < trailLen; t++) {
          const p = b.trail[t];
          const fade = (t + 1) / trailLen; // oldest = faintest (linear fade)
          const trailAlpha = trailBaseAlpha * fade;
          ctx.beginPath();
          ctx.arc(p.x, p.y, RADIUS * 0.8, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${color}, ${trailAlpha})`;
          ctx.fill();
        }
      }

      const angle = Math.atan2(b.vy, b.vx);
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const speedRatio = Math.min(1, (speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED));
      const alpha = baseAlpha * (0.5 + speedRatio * 0.5);

      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(angle);
      const r = RADIUS;
      ctx.beginPath();
      ctx.moveTo(r * 1.4, 0);
      ctx.lineTo(-r * 1.1, -r * 0.7);
      ctx.lineTo(-r * 0.6, 0);
      ctx.lineTo(-r * 1.1, r * 0.7);
      ctx.closePath();
      ctx.fillStyle = `rgba(${color}, ${alpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${color}, ${alpha * 0.35})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.restore();
    }

    // Connection lines (faint, accent color only) — disabled on mobile for perf
    if (CONNECTION_DIST > 0) {
      const connAlpha = isDark ? 0.04 : 0.025;
      ctx.strokeStyle = `rgba(${cachedAccentRGB}, ${connAlpha})`;
      ctx.lineWidth = 0.4;
      ctx.save();
      for (let i = 0; i < boids.length; i++) {
        for (let j = i + 1; j < boids.length; j++) {
          const dx = boids[i].x - boids[j].x;
          const dy = boids[i].y - boids[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECTION_DIST) {
            ctx.globalAlpha = 1 - dist / CONNECTION_DIST;
            ctx.beginPath();
            ctx.moveTo(boids[i].x, boids[i].y);
            ctx.lineTo(boids[j].x, boids[j].y);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }
  }

  function loop() {
    update();
    draw();
    animId = requestAnimationFrame(loop);
  }

  // ── public API: triggers for app.js events ──
  window.boidsBurst = () => { burstForce = 1.5; };
  window.boidsExpand = () => { expandForce = 1.2; };

  // ── start ──
  const start = () => {
    resize();
    initBoids();
    loop();
  };

  if (window.requestIdleCallback) {
    requestIdleCallback(start, { timeout: 2000 });
  } else {
    setTimeout(start, 100);
  }

  // Recalculate card bounds on resize/scroll only (not every frame)
  window.addEventListener("resize", () => {
    const prevCount = BOID_COUNT;
    recalcConfig();
    resize();
    // If boid count changed, re-init
    if (BOID_COUNT !== prevCount) initBoids();
  });
  window.addEventListener("scroll", updateCardRect, { passive: true });
  // Also update on DOM mutations (card appears after search)
  if (window.MutationObserver) {
    const obs = new MutationObserver(() => {
      updateCardRect();
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: false });
  }

  // Track cursor for parallax
  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }, { passive: true });
  document.addEventListener("mouseleave", () => {
    mouseX = -1000;
    mouseY = -1000;
  });
})();
