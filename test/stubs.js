// ── Minimal browser stubs so the engine can run headless ────────────────────
const _ls = new Map();
global.window = { localStorage: {
  getItem: k => _ls.has(k) ? _ls.get(k) : null,
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: k => _ls.delete(k),
}};
global.Papa = require(__dirname + '/../vendor/papaparse.js');
// React stub — only createElement/useState/useRef are touched by the code paths
// under test; no rendering happens in this harness.
global.React = { createElement: (t, p, ...c) => ({ t, p, c }), useState: v => [v, () => {}], useRef: () => ({ current: null }) };

// ── The app.js globals analytics.js calls at runtime ────────────────────────
global.median = function (sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
global.fmtDID = d => String(d);
global.npaLabel = c => 'Area ' + c;
global.MIN_MEDIAN_N = 6; global.DEGRADED_FRAC = 0.60;
global.MIN_AC_DIDS = 3;  global.MIN_AC_CALLS = 200;
