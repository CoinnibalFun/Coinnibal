// The follow camera of the school loop (plan-school.mjs and render.mjs --follow use the same one): from a
// take's telemetry (tele.json, 10 Hz), the box centre is goldie's position smoothed with a Gaussian of `sigma`
// seconds (no lag on a straight course, a soft curve where she turns) and its width is `k` times her radius,
// smoothed by a critically damped follow of `tau` seconds (after a gulp the view eases out as she grows, so
// she keeps her size in the frame). The box keeps the page's 16:10.
export function makeCam(tele, { k = 11, sigma = 0.35, tau = 0.3 } = {}) {
  const s = tele.filter((x) => x.me && x.screen === 'playing');
  const ts = s.map((x) => x.t);
  const at = (t) => { let lo = 0, hi = ts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
  // her radius on a fine grid, followed (critically damped) from the start of the take
  const DT = 1 / 120;
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const grid = new Float64Array(Math.ceil((t1 - t0) / DT) + 2);
  const rAt = (t) => {
    const i = Math.max(1, at(t));
    const a = s[i - 1], b = s[i];
    if (!a || !b) return Math.sqrt(s[0].me[2]) * 10;
    const u = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 1;
    return Math.sqrt(a.me[2] + (b.me[2] - a.me[2]) * u) * 10;
  };
  let y = rAt(t0), v = 0;
  const w = 1 / tau;
  for (let i = 0; i < grid.length; i++) {
    const t = t0 + i * DT;
    const target = rAt(t);
    // a jump of more than a third (she dropped in fresh) is taken at once
    if (Math.abs(target - y) > y / 3) { y = target; v = 0; }
    v += (w * w * (target - y) - 2 * w * v) * DT;
    y += v * DT;
    grid[i] = y;
  }
  const radius = (t) => {
    const f = Math.max(0, Math.min(grid.length - 1.001, (t - t0) / DT));
    const i = Math.floor(f);
    return grid[i] + (grid[i + 1] - grid[i]) * (f - i);
  };
  return (t) => {
    let sx = 0, sy = 0, sw = 0;
    for (let i = Math.max(0, at(t - sigma * 3)); i < s.length && s[i].t <= t + sigma * 3; i++) {
      const g = Math.exp(-((s[i].t - t) ** 2) / (2 * sigma * sigma));
      sx += s[i].me[0] * g; sy += s[i].me[1] * g; sw += g;
    }
    const r = radius(t);
    return { x: sx / sw, y: sy / sw, w: k * r, r };
  };
}
