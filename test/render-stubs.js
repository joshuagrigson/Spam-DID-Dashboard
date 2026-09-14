const _ls = new Map();
global.window = { localStorage: {
  getItem: k => _ls.has(k) ? _ls.get(k) : null,
  setItem: (k,v) => _ls.set(k,String(v)), removeItem: k => _ls.delete(k) }};
global.Papa = require(__dirname + '/../vendor/papaparse.js');
global.React = require('react');                 // the REAL React 18
global.median = function (s){ if(!s.length) return null; const m=Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
global.fmtDID = d => { const x=String(d).replace(/\D/g,''); const t=x.length===11?x.slice(1):x;
  return t.length===10 ? `(${t.slice(0,3)}) ${t.slice(3,6)}-${t.slice(6)}` : String(d); };
global.npaLabel = c => ({'201':'Hackensack, NJ','813':'Temple Terrace, FL','210':'San Antonio, TX'}[c] || 'Unknown area');
global.MIN_MEDIAN_N = 6; global.DEGRADED_FRAC = 0.60;
global.MIN_AC_DIDS = 3;  global.MIN_AC_CALLS = 200;
