// ── DID Dashboard — Intelligence layer (analytics.js) ─────────────────────────
// Loaded BEFORE app.js. Defines only stores, pure math and render helpers; every
// function that reaches into app.js globals (fmtDID, areaCode, npaLabel, median…)
// is called at render time, long after app.js has evaluated, so the ordering is safe.
//
// Three things live here that app.js could not do on its own:
//   1. SNAPSHOTS — app.js overwrites the pool on every import, so history was
//      being destroyed. Nothing downstream of "trend" was possible. Fixed here.
//   2. REPUTATION — carrier spam-flag ground truth imported from Ignite,
//      CallPurity, DNC.com and Caller ID Reputation.
//   3. DIAGNOSIS — the two-axis model that separates "this number is burned"
//      from "this number is fine and the list is bad". They are opposite fixes.

// ══ 1. SNAPSHOT HISTORY ══════════════════════════════════════════════════════
// One snapshot per calendar day. Same-day imports MERGE (union of DIDs, later
// value wins per number) so importing Southern Tier then Northern Tier on the
// same day keeps both instead of the second clobbering the first.
//
// Stored shape (deliberately terse — this is the file that grows):
//   { v:1, snaps:[ { t:<ms>, day:'YYYY-MM-DD', f:<fname>, d:{ phone:[calls,cr,dnc] } } ] }
const SNAP_KEY   = 'did_monitor_snapshots_v1';
const SNAP_MAX   = 120;                // hard cap on retained days
const SNAP_BYTES = 2 * 1024 * 1024;    // ~2MB ceiling; localStorage is ~5MB total

// THE join key. Convoso exports 11-digit (1NPANXXXXXX), some vendor tools export
// 10-digit, and a pasted table may carry formatting. Every store and every lookup
// must agree on one canonical form or the same number silently occupies two keys
// and its history splits in half. Defined once, used everywhere.
function canonPh(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return (d.length === 11 && d[0] === '1') ? d.slice(1) : d;
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const snapStore = {
  load() {
    try {
      const o = JSON.parse(window.localStorage.getItem(SNAP_KEY));
      if (!o || !Array.isArray(o.snaps)) return { v: 1, snaps: [] };
      return o;
    } catch (e) { return { v: 1, snaps: [] }; }
  },
  save(obj) {
    // Prune oldest-first until it fits both the count cap and the byte budget.
    // Dropping the oldest day costs the least: trends are read from the recent end.
    let snaps = obj.snaps.slice(-SNAP_MAX);
    let payload = JSON.stringify({ v: 1, snaps });
    while (snaps.length > 2 && payload.length > SNAP_BYTES) {
      snaps = snaps.slice(1);
      payload = JSON.stringify({ v: 1, snaps });
    }
    try { window.localStorage.setItem(SNAP_KEY, payload); return { v: 1, snaps }; }
    catch (e) { return { v: 1, snaps }; }   // quota hit — keep in memory only
  },
  clear() { try { window.localStorage.removeItem(SNAP_KEY); } catch (e) {} },

  // Record the pool as it stands right now. `rows` are post-import DID records.
  record(rows, fname) {
    if (!rows || !rows.length) return snapStore.load();
    const now  = Date.now();
    const day  = dayKey(now);
    const obj  = snapStore.load();
    const last = obj.snaps[obj.snaps.length - 1];
    const d    = (last && last.day === day) ? { ...last.d } : {};
    for (const r of rows) {
      const p = canonPh(r.did);
      if (!p) continue;
      d[p] = [ +r.calls || 0, Math.round((+r.cr || 0) * 10) / 10, +r.dncCount || 0 ];
    }
    const entry = { t: now, day, f: fname || '', d };
    const snaps = (last && last.day === day)
      ? [ ...obj.snaps.slice(0, -1), entry ]
      : [ ...obj.snaps, entry ];
    return snapStore.save({ v: 1, snaps });
  },
};

// ══ 2. REPUTATION (external spam-flag ground truth) ═══════════════════════════
// The dashboard has always inferred spam damage from contact rate. These tools
// MEASURE it. That difference is what makes the diagnosis two-axis instead of
// one — see classify() below.
const REP_KEY = 'did_monitor_reputation_v1';

// Carrier / database keys, normalized across vendors that all spell them differently.
const CARRIERS = [
  { k: 'att',        l: 'AT&T',        pat: ['att','at&t','atandt','cingular'] },
  { k: 'tmobile',    l: 'T-Mobile',    pat: ['tmobile','t-mobile','tmo','metropcs','metro'] },
  { k: 'verizon',    l: 'Verizon',     pat: ['verizon','vzw','vz'] },
  { k: 'sprint',     l: 'Sprint',      pat: ['sprint'] },
  { k: 'uscellular', l: 'US Cellular', pat: ['uscellular','usc','uscc'] },
  { k: 'hiya',       l: 'Hiya',        pat: ['hiya'] },
  { k: 'tns',        l: 'TNS',         pat: ['tns','transaction network'] },
  { k: 'firstorion', l: 'First Orion', pat: ['firstorion','first orion','forion'] },
  { k: 'nomorobo',   l: 'Nomorobo',    pat: ['nomorobo'] },
  { k: 'truecaller', l: 'Truecaller',  pat: ['truecaller'] },
  { k: 'robokiller', l: 'RoboKiller',  pat: ['robokiller'] },
];
const CARRIER_LB = CARRIERS.reduce((m, c) => (m[c.k] = c.l, m), {});

// Vendor registry. `sig` are header fragments that identify the file; the first
// vendor whose signature matches wins. Everything falls back to semantic
// detection, so an unknown export still imports — it just lands under "other".
const REP_VENDORS = [
  { id: 'ignite',      l: 'Convoso Ignite',        i: 'ti-flame',
    sig: ['ignite','reputation score','number health','health score'] },
  { id: 'callpurity',  l: 'CallPurity',            i: 'ti-shield-check',
    sig: ['callpurity','call purity','remediation','remediated'] },
  { id: 'dnccom',      l: 'DNC.com',               i: 'ti-phone-off',
    sig: ['dnc.com','litigator','dnc scrub','scrub','tcpa'] },
  { id: 'calleridrep', l: 'Caller ID Reputation',  i: 'ti-address-book',
    sig: ['calleridreputation','caller id reputation','spam likely','scam likely','caller id name'] },
  { id: 'other',       l: 'Other source',          i: 'ti-file-text', sig: [] },
];
const VENDOR_LB = REP_VENDORS.reduce((m, v) => (m[v.id] = v.l, m), {});

const repStore = {
  load() {
    try {
      const o = JSON.parse(window.localStorage.getItem(REP_KEY));
      if (!o || typeof o.byPhone !== 'object' || o.byPhone === null) return { v: 1, byPhone: {} };
      return o;
    } catch (e) { return { v: 1, byPhone: {} }; }
  },
  save(obj) {
    try { window.localStorage.setItem(REP_KEY, JSON.stringify(obj)); } catch (e) {}
    return obj;
  },
  clear() { try { window.localStorage.removeItem(REP_KEY); } catch (e) {} },

  // Merge one vendor's rows in. Per phone we keep ONE record per vendor —
  // the newest — so re-importing a fresh scan updates rather than duplicates.
  merge(records, vendorId) {
    const obj = repStore.load();
    const by  = { ...obj.byPhone };
    const now = Date.now();
    let added = 0, updated = 0;
    for (const r of records) {
      if (String(r.phone || '').replace(/\D/g, '').length < 10) continue;
      const key = canonPh(r.phone);
      const prev = by[key] || { vendors: {} };
      if (prev.vendors[vendorId]) updated++; else added++;
      by[key] = {
        ...prev,
        vendors: {
          ...prev.vendors,
          [vendorId]: {
            at: r.at || now,
            flagged: r.flagged,           // true | false | null (null = unknown)
            score: r.score,               // 0-100 vendor health score, or null
            label: r.label || '',         // e.g. "Scam Likely"
            carriers: r.carriers || {},   // { att:'flagged'|'clean', ... }
            status: r.status || '',       // e.g. "remediation filed"
          },
        },
      };
    }
    return { result: repStore.save({ v: 1, byPhone: by, at: now }), added, updated };
  },
};

// ── Reputation roll-up: many vendors, one verdict ────────────────────────────
// ANY vendor reporting a flag counts as flagged. False negatives (a carrier that
// simply has not scanned yet) are far more common than false positives, so the
// union is the honest read — and it is stated that way in the UI.
function repOf(phone, repBy) {
  const key = canonPh(phone);
  const rec = repBy && repBy[key];
  if (!rec || !rec.vendors || !Object.keys(rec.vendors).length) {
    return { known: false, flagged: null, score: null, vendors: [], carriers: {}, flaggedBy: [], at: null };
  }
  const vendors = Object.entries(rec.vendors);
  const carriers = {};
  const flaggedBy = [];
  let flagged = false, anyKnown = false, scoreSum = 0, scoreN = 0, at = null, labels = [];
  for (const [vid, v] of vendors) {
    if (v.flagged === true)  { flagged = true; anyKnown = true; flaggedBy.push(VENDOR_LB[vid] || vid); }
    if (v.flagged === false) anyKnown = true;
    if (typeof v.score === 'number' && !isNaN(v.score)) { scoreSum += v.score; scoreN++; }
    if (v.at && (!at || v.at > at)) at = v.at;
    if (v.label) labels.push(v.label);
    for (const [ck, cv] of Object.entries(v.carriers || {})) {
      if (cv === 'flagged') carriers[ck] = 'flagged';
      else if (cv === 'clean' && carriers[ck] !== 'flagged') carriers[ck] = 'clean';
    }
  }
  const flaggedCarriers = Object.entries(carriers).filter(([, s]) => s === 'flagged').map(([k]) => k);
  if (flaggedCarriers.length) flagged = true;
  return {
    known: anyKnown || scoreN > 0 || !!flaggedCarriers.length,
    flagged: (anyKnown || flaggedCarriers.length) ? flagged : null,
    score: scoreN ? Math.round(scoreSum / scoreN) : null,
    vendors: vendors.map(([vid]) => vid),
    carriers, flaggedCarriers, flaggedBy,
    labels: [...new Set(labels)],
    at,
  };
}

// ── Vendor-agnostic column detection ─────────────────────────────────────────
// Matches on MEANING, not on a memorized header list, so a vendor renaming a
// column does not silently break the import. Per-vendor signatures only pick
// the label and any vendor-specific quirks.
const repNorm = s => String(s).toLowerCase().replace(/[\s_\-\/().%]+/g, '');

function detectVendor(headers, fname) {
  const hay = (headers.join(' ') + ' ' + (fname || '')).toLowerCase();
  for (const v of REP_VENDORS) {
    if (v.sig.length && v.sig.some(s => hay.includes(s))) return v.id;
  }
  return 'other';
}

// Truthiness across every spelling these tools use for "this number is flagged".
const FLAG_YES = ['flagged','spam','scamlikely','spamlikely','fraud','blocked','block','yes','true','y','1','high','highrisk','positive','bad','atrisk','tagged'];
const FLAG_NO  = ['clean','clear','notflagged','none','no','false','n','0','ok','good','healthy','passed','pass','unflagged','negative','low'];

function parseFlag(v) {
  if (v === null || v === undefined) return null;
  const s = repNorm(v);
  if (!s) return null;
  if (FLAG_NO.some(t => s === t))  return false;   // exact-match clean first
  if (FLAG_YES.some(t => s === t)) return true;
  if (FLAG_NO.some(t => s.includes(t)))  return false;
  if (FLAG_YES.some(t => s.includes(t))) return true;
  return null;
}

function detectRepCols(headers) {
  const map = { phone: '', flag: '', score: '', label: '', date: '', status: '', carriers: {} };
  const used = new Set();
  const pick = (pats, exclude) => {
    for (const hdr of headers) {
      if (used.has(hdr)) continue;
      const n = repNorm(hdr);
      if (exclude && exclude.some(x => n.includes(x))) continue;
      if (pats.some(p => n === p || n.includes(p))) { used.add(hdr); return hdr; }
    }
    return '';
  };
  // Phone first — it is the join key and the only truly required column.
  map.phone = pick(['did','phonenumber','phone','number','callerid','ani','tn','telephone','tfn']);
  // Per-carrier columns before the generic flag column, so "AT&T Status" is not
  // mistaken for the overall verdict.
  for (const c of CARRIERS) {
    for (const hdr of headers) {
      if (used.has(hdr) || hdr === map.phone) continue;
      const n = repNorm(hdr);
      if (c.pat.some(p => n.includes(repNorm(p)))) { map.carriers[c.k] = hdr; used.add(hdr); break; }
    }
  }
  map.score  = pick(['reputationscore','healthscore','score','rating','reputation','health']);
  map.flag   = pick(['flagstatus','spamstatus','flagged','isflagged','spam','status','flag','result','verdict','risk'], ['remediation']);
  map.label  = pick(['displayname','callerIdname','spamlabel','label','cnam','name','displayas','reason']);
  map.date   = pick(['lastchecked','checkedat','scandate','lastscan','datechecked','updated','timestamp','date']);
  map.status = pick(['remediationstatus','remediation','ticket','case','submitted']);
  return map;
}

// Turn parsed CSV rows into normalized reputation records.
function buildRepRecords(rows, cols, vendorId) {
  const out = [];
  for (const row of rows) {
    const rawPhone = cols.phone ? row[cols.phone] : '';
    const p = canonPh(rawPhone);
    if (p.length < 10) continue;

    const carriers = {};
    let carrierFlagged = false, carrierSeen = false;
    for (const [ck, hdr] of Object.entries(cols.carriers)) {
      const f = parseFlag(row[hdr]);
      if (f === null) continue;
      carrierSeen = true;
      carriers[ck] = f ? 'flagged' : 'clean';
      if (f) carrierFlagged = true;
    }

    let flagged = cols.flag ? parseFlag(row[cols.flag]) : null;
    if (flagged === null && carrierSeen) flagged = carrierFlagged;
    else if (carrierFlagged) flagged = true;

    let score = null;
    if (cols.score) {
      const n = parseFloat(String(row[cols.score]).replace(/[^0-9.\-]/g, ''));
      if (!isNaN(n)) score = Math.max(0, Math.min(100, n));
    }
    // A vendor health score with no explicit flag column still tells us plenty.
    // Ignite scores 1-100 where low is bad; treat the bottom third as flagged.
    if (flagged === null && score !== null) flagged = score < 34;

    let at = Date.now();
    if (cols.date) { const t = Date.parse(row[cols.date]); if (!isNaN(t)) at = t; }

    out.push({
      phone: p, flagged, score, at,
      label:  cols.label  ? String(row[cols.label]  || '').trim() : '',
      status: cols.status ? String(row[cols.status] || '').trim() : '',
      carriers,
    });
  }
  return out;
}

// Accepts pasted text as well as a file: CSV, TSV, or a table copied straight
// out of a vendor's web UI. This is the path that makes "scrape it" workable
// without credentials — copy the table, paste it here.
function parseRepText(text) {
  const t = String(text || '').trim();
  if (!t) return { headers: [], rows: [] };
  const firstLine = t.split(/\r?\n/)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delim = tabs >= commas ? '\t' : ',';
  const res = Papa.parse(t, { header: true, skipEmptyLines: true, delimiter: delim });
  const headers = (res.meta && res.meta.fields) ? res.meta.fields.filter(Boolean) : [];
  return { headers, rows: res.data || [] };
}

// ══ 3. TREND MATH ════════════════════════════════════════════════════════════
// Contact rate is the trendable metric. Raw call COUNTS are not comparable
// between snapshots unless every report was pulled over an identical window,
// and that is not something the dashboard can verify — so volume deltas are
// shown as "as reported" and never drive a recommendation on their own.

const TREND_MIN_PTS  = 2;
const TREND_FALL_REL = -20;   // % relative drop in contact rate = falling
const TREND_COLL_REL = -35;   // …and this steep = collapsing
const TREND_RISE_REL = 20;
const TREND_MIN_PTS_ABS = 1.5; // absolute CR points, so 0.4%→0.3% is not "a 25% collapse"

// Least-squares slope of y against x. Returns null when x has no spread.
function lsSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}

// Per-number contact-rate history. `snaps` oldest → newest.
function trendFor(phone, snaps) {
  const key = canonPh(phone);
  const pts = [];
  for (const s of snaps) {
    // '1'+key covers snapshots written before keys were canonicalised.
    const v = s.d[key] || s.d['1' + key];
    if (!v) continue;
    pts.push({ t: s.t, calls: v[0], cr: v[1], dnc: v[2] });
  }
  if (pts.length < TREND_MIN_PTS) {
    return { ok: false, n: pts.length, pts, dir: 'new', deltaPts: null, relPct: null, perWeek: null, spanDays: 0 };
  }
  const first = pts[0], last = pts[pts.length - 1];
  const spanDays = Math.max(0, (last.t - first.t) / 86400000);
  const deltaPts = last.cr - first.cr;
  const relPct   = first.cr > 0 ? (deltaPts / first.cr) * 100 : null;

  const days = pts.map(p => (p.t - first.t) / 86400000);
  const slope = lsSlope(days, pts.map(p => p.cr));           // CR points per day
  const perWeek = slope === null ? null : slope * 7;

  // Both tests must agree before calling a direction: a big relative move on a
  // tiny base is noise, and a big absolute move on a huge base is not a crisis.
  let dir = 'flat';
  if (relPct !== null && Math.abs(deltaPts) >= TREND_MIN_PTS_ABS) {
    if      (relPct <= TREND_COLL_REL) dir = 'collapsing';
    else if (relPct <= TREND_FALL_REL) dir = 'falling';
    else if (relPct >= TREND_RISE_REL) dir = 'rising';
  }
  return { ok: true, n: pts.length, pts, dir, deltaPts, relPct, perWeek, spanDays, first, last,
           dncDelta: last.dnc - first.dnc };
}

// Pool-level history: one row per snapshot day.
function poolTrend(snaps) {
  return snaps.map(s => {
    const vals = Object.values(s.d);
    const scorable = vals.filter(v => v[0] >= 25);
    const crs = scorable.map(v => v[1]).sort((a, b) => a - b);
    const calls = scorable.reduce((a, v) => a + v[0], 0);
    const wCr = calls > 0 ? scorable.reduce((a, v) => a + v[1] * v[0], 0) / calls : null;
    const dnc = vals.reduce((a, v) => a + v[2], 0);
    return {
      t: s.t, day: s.day, f: s.f,
      dids: vals.length, scorable: scorable.length,
      calls, avgCr: wCr, medCr: median(crs),
      dnc, dnc1k: calls > 0 ? (dnc / calls) * 1000 : 0,
    };
  });
}

// Per-area-code history — median contact rate inside the area code over time.
function areaTrend(code, snaps) {
  const out = [];
  for (const s of snaps) {
    const crs = [];
    let calls = 0, dnc = 0, dids = 0;
    for (const [p, v] of Object.entries(s.d)) {
      if (canonPh(p).substring(0, 3) !== code) continue;
      dids++; calls += v[0]; dnc += v[2];
      if (v[0] >= 25) crs.push(v[1]);
    }
    if (!dids) continue;
    crs.sort((a, b) => a - b);
    out.push({ t: s.t, day: s.day, dids, calls, dnc, medCr: median(crs), n: crs.length });
  }
  return out;
}

// ══ 4. DIAGNOSIS — the two-axis model ════════════════════════════════════════
// Axis 1 REPUTATION: do the carriers say this number is flagged? (ground truth,
//   imported from Ignite / CallPurity / DNC.com / Caller ID Reputation)
// Axis 2 PERFORMANCE: is it converting relative to its OWN area code? (inferred)
//
// Holding them apart is the whole point. A number that is flagged needs a new
// number or a remediation filing. A number that is CLEAN with carriers but has a
// low contact rate does not have a spam problem at all — it has a list, timing or
// targeting problem, and replacing it burns money and fixes nothing. Contact rate
// alone can never tell those two apart, which is exactly the open question the
// 2026-08-19 scoring review left unresolved. Reputation data answers it.

const DIAGS = {
  burned:      { l: 'Burned — replace',            sev: 4, c: '#9b1c1c', i: 'ti-flame',
                 act: 'Queue for replacement. Carriers are flagging it and performance has followed.' },
  collapsing:  { l: 'Collapsing',                  sev: 4, c: '#9b1c1c', i: 'ti-trending-down',
                 act: 'Pull it from rotation now and check reputation — this is the shape of a fresh flag.' },
  flagged_ok:  { l: 'Flagged but still working',   sev: 3, c: '#d97706', i: 'ti-alert-triangle',
                 act: 'File remediation before replacing. It still converts, so a swap costs more than a fix.' },
  falling:     { l: 'Trending down',               sev: 3, c: '#d97706', i: 'ti-arrow-down-right',
                 act: 'Rest it or cut its daily volume, and scan it for flags this week.' },
  dnc:         { l: 'DNC pressure',                sev: 3, c: '#d97706', i: 'ti-phone-off',
                 act: 'People are actively asking off this number. Replace it before carriers act.' },
  damaged:     { l: 'Damaged vs its area code',    sev: 3, c: '#d97706', i: 'ti-heart-broken',
                 act: 'Its neighbours in the same area code do far better, so geography is ruled out. Replace.' },
  list_problem:{ l: 'Clean — list problem',        sev: 2, c: '#2563c9', i: 'ti-list-search',
                 act: 'Carriers say this number is fine. Do NOT replace it — look at the list, the hours and the offer.' },
  unknown_low: { l: 'Low rate, unscanned',         sev: 2, c: '#2563c9', i: 'ti-help-circle',
                 act: 'Underperforming with no reputation data. Scan it before deciding anything.' },
  overworked:  { l: 'Carrying too much',           sev: 2, c: '#2563c9', i: 'ti-weight',
                 act: 'Volume per number is well above the pool. Add numbers in this area code to spread the load.' },
  recovering:  { l: 'Recovering',                  sev: 1, c: '#3f7d12', i: 'ti-arrow-up-right',
                 act: 'Improving. Leave it alone and let it keep building.' },
  healthy:     { l: 'Healthy',                     sev: 0, c: '#3f7d12', i: 'ti-circle-check',
                 act: 'No action.' },
  nodata:      { l: 'Not enough calls',            sev: 0, c: '#6b7280', i: 'ti-minus',
                 act: 'Under 25 calls — nothing can be concluded yet.' },
};

const ABS_LOW_CR = 12;   // absolute contact-rate floor, below which a number underperforms
                         // regardless of region. Deliberately generous: a low-answering
                         // region should not be mistaken for carrier damage.

// ctx: { acMed: {code: medianCr}, acN: {code: scorableCount}, poolPerDid, repBy, snaps }
function classify(d, ctx) {
  const why = [];
  if (!d.calls || d.calls < 25) return { key: 'nodata', ...DIAGS.nodata, why: ['Under 25 calls.'], rep: repOf(d.did, ctx.repBy), trend: null };

  const rep   = repOf(d.did, ctx.repBy);
  const trend = ctx.snaps && ctx.snaps.length ? trendFor(d.did, ctx.snaps) : null;

  const med   = ctx.acMed[d.area];
  const acOk  = ctx.acN[d.area] >= MIN_MEDIAN_N && med > 0;
  const damaged = acOk && d.cr < med * DEGRADED_FRAC;

  if (rep.flagged === true) {
    why.push('Flagged by ' + (rep.flaggedBy.length ? rep.flaggedBy.join(', ') : 'a reputation source') + '.');
    if (rep.flaggedCarriers && rep.flaggedCarriers.length) {
      why.push('Carriers flagging: ' + rep.flaggedCarriers.map(c => CARRIER_LB[c] || c).join(', ') + '.');
    }
  }
  if (damaged) why.push('Contact rate ' + d.cr.toFixed(1) + '% vs ' + med.toFixed(1) + '% median in area code ' + d.area + '.');
  if (trend && trend.ok && trend.dir !== 'flat') {
    why.push('Contact rate ' + (trend.deltaPts >= 0 ? 'up ' : 'down ') + Math.abs(trend.deltaPts).toFixed(1)
      + ' pts (' + (trend.relPct >= 0 ? '+' : '') + trend.relPct.toFixed(0) + '%) over ' + Math.round(trend.spanDays) + ' days.');
  }
  if (d.dncCount >= 1) why.push(d.dncCount + ' DNC request' + (d.dncCount === 1 ? '' : 's') + ' on record.');

  const pick = (k, actOverride) => ({
    key: k, ...DIAGS[k], why, rep, trend, damaged, acMed: med,
    act: actOverride || DIAGS[k].act,
  });

  // Order is priority — first match wins — and the ordering encodes one rule:
  // MEASURED beats INFERRED. "Damaged vs its area code" is an inference drawn
  // from contact rate. A carrier scan is a measurement. So a number the carriers
  // have actually looked at and called clean must not be sentenced as damaged on
  // the strength of the inference the scan just contradicted; the money-losing
  // mistake this whole model exists to prevent is replacing that number.
  if (rep.flagged === true && (damaged || d.dncCount >= 4)) return pick('burned');
  if (trend && trend.dir === 'collapsing')                  return pick('collapsing');
  if (rep.flagged === true)                                 return pick('flagged_ok');
  if (trend && trend.dir === 'falling')                     return pick('falling');
  // DNC pressure is people asking off the number. That is real whatever the
  // carriers currently say, so it stays above the reputation override.
  if (d.dncCount >= 4 && d.calls > 50 && d.cr <= 25)        return pick('dnc');

  // ── The override. Carriers say clean; the number still underperforms. ──
  if (rep.flagged === false && (damaged || d.cr < ABS_LOW_CR)) {
    return pick('list_problem', damaged
      ? 'Carriers scanned this number and called it CLEAN, yet it trails the other numbers in '
        + d.area + '. A replacement would be buying a new number to fix something the scan says '
        + 'is not the number. Look at the list, the dial hours and the offer first.'
      : DIAGS.list_problem.act);
  }

  // No scan on record: the in-area comparison is the strongest evidence there is,
  // so it still stands — but say plainly that it is an inference, not a measurement.
  if (damaged) {
    return pick('damaged', rep.known ? DIAGS.damaged.act
      : 'Its neighbours in the same area code do far better, so geography is ruled out. '
        + 'No carrier scan on record though — scan it before spending money on a replacement, '
        + 'because a clean result would mean the list is the problem, not the number.');
  }
  if (d.cr < ABS_LOW_CR && !rep.known)                      return pick('unknown_low');
  if (trend && trend.dir === 'rising')                      return pick('recovering');
  if (ctx.poolPerDid > 0 && d.calls >= ctx.poolPerDid * 2)  return pick('overworked');
  return pick('healthy');
}

// Build the context classify() needs, once per render rather than per row.
function buildCtx(rows, repBy, snaps) {
  const byAc = {};
  for (const d of rows) {
    (byAc[d.area] = byAc[d.area] || []).push(d);
  }
  const acMed = {}, acN = {};
  for (const [code, list] of Object.entries(byAc)) {
    const crs = list.filter(d => d.calls >= 25).map(d => d.cr).sort((a, b) => a - b);
    acN[code] = crs.length;
    acMed[code] = median(crs);
  }
  const totCalls = rows.reduce((a, d) => a + (d.calls || 0), 0);
  return { acMed, acN, repBy, snaps, poolPerDid: rows.length ? totCalls / rows.length : 0 };
}

// ══ 5. BUY LIST — "which area codes need beefing up, and by how many" ════════
// Under local presence an area code cannot be swapped for a cheaper one, so the
// only lever is DEPTH: how many working numbers carry that area code's volume.
// need = numbers required to bring volume-per-working-number down to target.
//
// Gated on the same minimums the area-code board uses. Recommending a purchase
// off three numbers and a hundred calls would be false precision, so those area
// codes are listed separately as "watch, not enough data" instead of hidden.
const BUY_TARGET_DEFAULT = 200;   // calls per number per report window

function buyList(rows, ctx, targetDepth) {
  const target = targetDepth && targetDepth > 0 ? targetDepth : BUY_TARGET_DEFAULT;
  const byAc = {};
  for (const d of rows) {
    const a = (byAc[d.area] = byAc[d.area] || { code: d.area, dids: 0, calls: 0, dnc: 0, bad: 0, flagged: 0, crs: [], rows: [] });
    a.dids++; a.calls += d.calls || 0; a.dnc += d.dncCount || 0; a.rows.push(d);
    if (d.calls >= 25) a.crs.push(d.cr);
    if (d.diag && d.diag.sev >= 3) a.bad++;
    if (d.diag && d.diag.rep && d.diag.rep.flagged === true) a.flagged++;
  }
  const out = [];
  for (const a of Object.values(byAc)) {
    a.crs.sort((x, y) => x - y);
    a.medCr = median(a.crs);
    a.working = a.dids - a.bad;                       // numbers you can actually rely on
    a.depth   = a.working > 0 ? a.calls / a.working : Infinity;
    a.lowData = a.dids < MIN_AC_DIDS || a.calls < MIN_AC_CALLS;
    a.need    = Math.max(0, Math.ceil(a.calls / target) - a.working);
    a.badShare = a.dids ? a.bad / a.dids : 0;
    // Priority = volume actually exposed. An area code with 4,000 calls and half
    // its numbers damaged outranks one with 200 calls and all of them damaged.
    a.priority = Math.round((a.calls * a.badShare) + (a.need * 50) + (a.flagged * 120));
    a.label = npaLabel(a.code);
    out.push(a);
  }
  return out.sort((x, y) => y.priority - x.priority);
}

// ══ 6. RENDER PRIMITIVES ═════════════════════════════════════════════════════
const hx = React.createElement;

const nfmt  = n => (n === null || n === undefined || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
const pfmt  = (n, d) => (n === null || n === undefined || isNaN(n)) ? '—' : n.toFixed(d === undefined ? 1 : d) + '%';
const sgn   = n => (n === null || n === undefined || isNaN(n)) ? '—' : (n > 0 ? '+' : '') + n.toFixed(1);
const daysAgo = ms => {
  if (!ms) return 'never';
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
};

// Severity chip. Colour NEVER travels alone — every chip carries its icon and
// its name, so the meaning survives colourblindness, greyscale printing and
// a screenshot pasted into Slack.
function sevChip(diag, opts) {
  const o = opts || {};
  return hx('span', { className: 'dx-chip' + (o.sm ? ' dx-chip-sm' : ''),
                      style: { '--dx': diag.c }, title: diag.act },
    hx('i', { className: 'ti ' + diag.i }),
    hx('span', null, diag.l));
}

// Single-series sparkline. No axes, no legend — it lives inside a table row and
// its job is shape, not value. The value is in the column beside it.
function sparkline(pts, opts) {
  const o = opts || {};
  const w = o.w || 84, ht = o.h || 24, pad = 3;
  if (!pts || pts.length < 2) return hx('span', { className: 'dx-spark-none' }, '—');
  const ys = pts.map(p => p.cr);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const rng = (hi - lo) || 1;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const tr = (t1 - t0) || 1;
  const X = p => pad + ((p.t - t0) / tr) * (w - pad * 2);
  const Y = p => ht - pad - ((p.cr - lo) / rng) * (ht - pad * 2);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p).toFixed(1) + ' ' + Y(p).toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return hx('svg', { className: 'dx-spark', width: w, height: ht, viewBox: `0 0 ${w} ${ht}`,
                     role: 'img', 'aria-label': 'contact rate trend' },
    hx('path', { d, fill: 'none', stroke: o.c || '#5b6478', strokeWidth: 2,
                 strokeLinecap: 'round', strokeLinejoin: 'round' }),
    hx('circle', { cx: X(last), cy: Y(last), r: 2.6, fill: o.c || '#5b6478' }));
}

// ── Time-series line chart with a crosshair + tooltip ────────────────────────
// One measure per chart. Two measures of different scale get two charts — a
// second y-axis would make the crossing point look meaningful when it is not.
function TrendChart(props) {
  const { series, label, fmt, height, color } = props;
  const [hoverIdx, setHoverIdx] = React.useState(null);
  const W = 100, H = height || 40, padL = 2, padR = 2, padT = 4, padB = 4;

  const pts = series.filter(p => p.v !== null && p.v !== undefined && !isNaN(p.v));
  if (pts.length < 2) return null;

  const vs = pts.map(p => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo;
  // Never let a flat line fill the frame — pad the band so small wobbles read small.
  if (span < 0.0001) { lo -= 1; hi += 1; }
  else { lo -= span * 0.15; hi += span * 0.15; }
  const rng = hi - lo;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, tr = (t1 - t0) || 1;
  const X = p => padL + ((p.t - t0) / tr) * (W - padL - padR);
  const Y = p => padT + (1 - (p.v - lo) / rng) * (H - padT - padB);

  const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p).toFixed(2) + ' ' + Y(p).toFixed(2)).join(' ');
  const area = line + ` L ${X(pts[pts.length - 1]).toFixed(2)} ${H - padB} L ${X(pts[0]).toFixed(2)} ${H - padB} Z`;
  const c = color || '#2563c9';
  const hv = hoverIdx === null ? null : pts[hoverIdx];
  const show = fmt || (v => v.toFixed(1));

  // Gridlines are recessive on purpose: the data is the subject.
  const grid = [0, 0.5, 1].map(f => padT + f * (H - padT - padB));

  return hx('div', { className: 'dx-chart-wrap' },
    hx('div', { className: 'dx-chart-head' },
      hx('span', { className: 'dx-chart-label' }, label),
      hx('span', { className: 'dx-chart-now' },
        hv ? show(hv.v) + ' · ' + hv.day : show(pts[pts.length - 1].v) + ' latest')),
    hx('svg', {
      className: 'dx-chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
      role: 'img', 'aria-label': label,
      onMouseLeave: () => setHoverIdx(null),
      onMouseMove: ev => {
        const r = ev.currentTarget.getBoundingClientRect();
        if (!r.width) return;
        const fx = ((ev.clientX - r.left) / r.width) * W;
        let best = 0, bd = Infinity;
        pts.forEach((p, i) => { const dd = Math.abs(X(p) - fx); if (dd < bd) { bd = dd; best = i; } });
        setHoverIdx(best);
      },
    },
      grid.map((y, i) => hx('line', { key: 'g' + i, x1: 0, x2: W, y1: y, y2: y,
                                      stroke: '#000', strokeOpacity: 0.07, strokeWidth: 0.4,
                                      vectorEffect: 'non-scaling-stroke' })),
      hx('path', { d: area, fill: c, fillOpacity: 0.10 }),
      hx('path', { d: line, fill: 'none', stroke: c, strokeWidth: 2,
                   strokeLinecap: 'round', strokeLinejoin: 'round',
                   vectorEffect: 'non-scaling-stroke' }),
      hv && hx('line', { x1: X(hv), x2: X(hv), y1: padT, y2: H - padB,
                         stroke: c, strokeOpacity: 0.45, strokeWidth: 1,
                         vectorEffect: 'non-scaling-stroke' }),
      hv && hx('circle', { cx: X(hv), cy: Y(hv), r: 2.4, fill: c,
                           stroke: '#fff', strokeWidth: 1.2, vectorEffect: 'non-scaling-stroke' }),
    ),
    hx('div', { className: 'dx-chart-axis' },
      hx('span', null, pts[0].day),
      hx('span', null, pts[pts.length - 1].day)));
}

// Horizontal magnitude bar for in-table comparison. Thin mark, rounded data-end.
function magBar(v, max, color) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
  return hx('div', { className: 'dx-mag' },
    hx('div', { className: 'dx-mag-fill', style: { width: pct + '%', background: color || '#2563c9' } }));
}

// ══ 7. COMMAND CENTER ════════════════════════════════════════════════════════
// The plain-language front page: what is wrong, how bad, and what to do — in
// that order, in words, before any table. Everything here is grouped by the
// FIX, not by the metric, because the fix is the thing that gets actioned.
function CommandCenter(props) {
  const { rows, snaps, repBy } = props;
  const [openGrp, setOpenGrp] = React.useState(null);

  const scorable = rows.filter(r => r.diag && r.diag.key !== 'nodata');
  const groups = {};
  for (const r of scorable) {
    const g = (groups[r.diag.key] = groups[r.diag.key] || { key: r.diag.key, d: r.diag, rows: [], calls: 0 });
    g.rows.push(r); g.calls += r.calls || 0;
  }
  const list = Object.values(groups)
    .sort((a, b) => (b.d.sev - a.d.sev) || (b.calls - a.calls));

  const act    = scorable.filter(r => r.diag.sev >= 3);
  const actCalls = act.reduce((a, r) => a + (r.calls || 0), 0);
  const totCalls = scorable.reduce((a, r) => a + (r.calls || 0), 0);
  const listProb = scorable.filter(r => r.diag.key === 'list_problem');
  const scanned  = rows.filter(r => r.diag && r.diag.rep && r.diag.rep.known).length;

  // The one sentence that should be true whether or not anyone scrolls.
  const headline = !scorable.length
    ? 'No number in this view has enough calls to judge yet.'
    : act.length === 0
      ? 'Nothing needs replacing today. ' + scorable.length.toLocaleString() + ' numbers scored, none in the act-now bands.'
      : act.length + (act.length === 1 ? ' number needs action' : ' numbers need action')
        + ' — they carry ' + nfmt(actCalls) + ' calls, '
        + (totCalls ? Math.round((actCalls / totCalls) * 100) : 0) + '% of everything dialled in this view.';

  return hx('div', null,
    hx('div', { className: 'dx-hero' + (act.length ? ' dx-hero-warn' : '') },
      hx('i', { className: 'ti ' + (act.length ? 'ti-alert-triangle' : 'ti-circle-check') }),
      hx('div', null,
        hx('div', { className: 'dx-hero-line' }, headline),
        hx('div', { className: 'dx-hero-sub' },
          scanned === 0
            ? 'No reputation data imported yet — every verdict below is inferred from contact rate alone. Import an Ignite / CallPurity / DNC.com / Caller ID Reputation export on the Reputation tab to replace guesses with carrier ground truth.'
            : scanned.toLocaleString() + ' of ' + rows.length.toLocaleString() + ' numbers have carrier reputation data. '
              + (listProb.length
                  ? listProb.length + ' underperforming ' + (listProb.length === 1 ? 'number is' : 'numbers are')
                    + ' confirmed CLEAN with carriers — replacing those would fix nothing.'
                  : '')))),

    // Counts by fix, biggest problem first.
    hx('div', { className: 'dx-grid' },
      list.map(g => {
        const open = openGrp === g.key;
        const top = [...g.rows].sort((a, b) => (b.calls || 0) - (a.calls || 0));
        return hx('div', { key: g.key, className: 'dx-card' + (open ? ' dx-card-open' : ''), style: { '--dx': g.d.c } },
          hx('button', { className: 'dx-card-h', onClick: () => setOpenGrp(open ? null : g.key) },
            hx('span', { className: 'dx-card-n' }, g.rows.length),
            hx('span', { className: 'dx-card-t' },
              hx('span', { className: 'dx-card-l' }, hx('i', { className: 'ti ' + g.d.i }), g.d.l),
              hx('span', { className: 'dx-card-c' }, nfmt(g.calls) + ' calls')),
            hx('i', { className: 'ti ' + (open ? 'ti-chevron-up' : 'ti-chevron-down'), style: { opacity: .5 } })),
          hx('div', { className: 'dx-card-act' }, g.d.act),
          open && hx('div', { className: 'dx-card-body' },
            hx('table', { className: 'dx-table' },
              hx('thead', null, hx('tr', null,
                hx('th', null, 'Number'), hx('th', null, 'Area'),
                hx('th', { className: 'num' }, 'Calls'), hx('th', { className: 'num' }, 'Contact'),
                hx('th', { className: 'num' }, 'DNC'), hx('th', null, 'Trend'), hx('th', null, 'Why'))),
              hx('tbody', null, top.slice(0, 40).map(r => hx('tr', { key: r.did },
                hx('td', { className: 'mono' }, fmtDID(r.did)),
                hx('td', null, r.area + ' · ' + npaLabel(r.area)),
                hx('td', { className: 'num' }, nfmt(r.calls)),
                hx('td', { className: 'num' }, pfmt(r.cr)),
                hx('td', { className: 'num' }, r.dncCount || 0),
                hx('td', null, r.diag.trend && r.diag.trend.ok
                  ? sparkline(r.diag.trend.pts, { c: g.d.c })
                  : hx('span', { className: 'dx-spark-none' }, 'new')),
                hx('td', { className: 'dx-why' }, (r.diag.why || []).join(' ')))))),
            top.length > 40 && hx('div', { className: 'dx-more' },
              'Showing the 40 highest-volume of ' + top.length + '. Export CSV for the full set.'))); 
      })),

    !scorable.length && hx('div', { className: 'dx-empty' },
      hx('i', { className: 'ti ti-inbox' }),
      hx('div', null, 'Nothing scorable yet — numbers need at least 25 calls before any verdict is honest.')));
}

// ══ 8. TRENDS ════════════════════════════════════════════════════════════════
// Only possible because snapshots exist. Before this, every import destroyed the
// previous one and "trend" had nothing to stand on.
function TrendsView(props) {
  const { rows, snaps, onBackfill } = props;
  const [sortBy, setSortBy] = React.useState('fall');
  const backfillBtn = primary => onBackfill && hx('button',
    { className: 'dx-btn' + (primary ? ' dx-btn-p' : ''), onClick: onBackfill },
    hx('i', { className: 'ti ti-history' }), 'Back-fill from saved reports');

  if (!snaps || snaps.length < 2) {
    return hx('div', { className: 'dx-empty dx-empty-lg' },
      hx('i', { className: 'ti ti-chart-line' }),
      hx('div', { className: 'dx-empty-t' },
        snaps.length === 1 ? 'One report on record — trends start at the second.' : 'No history yet.'),
      hx('div', { className: 'dx-empty-s' },
        'Every Convoso import from now on is kept as a dated snapshot, so this page fills itself in. '
        + (snaps.length === 1
            ? 'The first was captured on ' + snaps[0].day + '. Import the next report and this turns into real trend lines.'
            : 'Import a Contact Rate Report from the Pool view to start the record.')
        + ' Nothing is back-filled automatically — but if you have older Convoso reports saved, '
        + 'replay them here and this page works today instead of in a fortnight.'),
      hx('div', { style: { marginTop: 14 } }, backfillBtn(true)));
  }

  const pool = poolTrend(snaps);
  const first = pool[0], last = pool[pool.length - 1];
  const crDelta = (last.avgCr !== null && first.avgCr !== null) ? last.avgCr - first.avgCr : null;
  const dncDelta = last.dnc1k - first.dnc1k;
  const spanDays = Math.round((last.t - first.t) / 86400000);

  // Movers — per-number trends, only where two or more observations exist.
  const moved = rows
    .map(r => ({ r, t: trendFor(r.did, snaps) }))
    .filter(x => x.t.ok && x.r.calls >= 25);
  const fallers = [...moved].filter(x => x.t.relPct !== null).sort((a, b) => a.t.relPct - b.t.relPct);
  const risers  = [...moved].filter(x => x.t.relPct !== null).sort((a, b) => b.t.relPct - a.t.relPct);
  const shown = sortBy === 'fall' ? fallers.slice(0, 25) : risers.slice(0, 25);

  const kpi = (lb, val, delta, good) => hx('div', { className: 'dx-kpi' },
    hx('div', { className: 'dx-kpi-l' }, lb),
    hx('div', { className: 'dx-kpi-v' }, val),
    delta !== null && hx('div', {
      className: 'dx-kpi-d ' + (delta === 0 ? '' : ((delta > 0) === good ? 'up' : 'down')) },
      hx('i', { className: 'ti ' + (delta > 0 ? 'ti-arrow-up-right' : delta < 0 ? 'ti-arrow-down-right' : 'ti-minus') }),
      sgn(delta) + ' over ' + spanDays + 'd'));

  return hx('div', null,
    hx('div', { className: 'dx-note' },
      hx('i', { className: 'ti ti-info-circle' }),
      hx('div', null,
        hx('b', null, 'Contact rate is the trendable number. '),
        'It is a ratio, so it compares cleanly between reports. Raw call COUNTS depend on the window each '
        + 'report was pulled over, which the dashboard cannot verify — so volume is shown as reported and '
        + 'never drives a recommendation by itself. ',
        snaps.length + ' snapshots on record, ' + spanDays + ' days from ' + first.day + ' to ' + last.day + '.')),

    hx('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 4 } }, backfillBtn(false)),

    hx('div', { className: 'dx-kpis' },
      kpi('Pool contact rate', pfmt(last.avgCr), crDelta, true),
      kpi('DNC per 1,000 calls', last.dnc1k.toFixed(2), dncDelta, false),
      kpi('Numbers tracked', nfmt(last.dids), last.dids - first.dids, true),
      kpi('Scorable (25+ calls)', nfmt(last.scorable), last.scorable - first.scorable, true)),

    hx('div', { className: 'dx-charts' },
      hx('div', { className: 'dx-chart-card' },
        hx(TrendChart, { series: pool.map(p => ({ t: p.t, day: p.day, v: p.avgCr })),
                         label: 'Pool contact rate', fmt: v => v.toFixed(1) + '%', color: '#2563c9' })),
      hx('div', { className: 'dx-chart-card' },
        hx(TrendChart, { series: pool.map(p => ({ t: p.t, day: p.day, v: p.dnc1k })),
                         label: 'DNC requests per 1,000 calls', fmt: v => v.toFixed(2), color: '#d97706' }))),

    hx('div', { className: 'dx-movers' },
      hx('div', { className: 'dx-movers-h' },
        hx('span', null, 'Biggest movers'),
        hx('div', { className: 'dx-seg' },
          hx('button', { className: sortBy === 'fall' ? 'on' : '', onClick: () => setSortBy('fall') },
            hx('i', { className: 'ti ti-arrow-down-right' }), 'Falling'),
          hx('button', { className: sortBy === 'rise' ? 'on' : '', onClick: () => setSortBy('rise') },
            hx('i', { className: 'ti ti-arrow-up-right' }), 'Rising'))),
      !shown.length
        ? hx('div', { className: 'dx-empty' }, hx('i', { className: 'ti ti-minus' }),
             hx('div', null, 'No number has two observations yet.'))
        : hx('table', { className: 'dx-table' },
            hx('thead', null, hx('tr', null,
              hx('th', null, 'Number'), hx('th', null, 'Area'), hx('th', null, 'Trend'),
              hx('th', { className: 'num' }, 'Was'), hx('th', { className: 'num' }, 'Now'),
              hx('th', { className: 'num' }, 'Change'), hx('th', { className: 'num' }, 'Calls'),
              hx('th', null, 'Diagnosis'))),
            hx('tbody', null, shown.map(({ r, t }) => hx('tr', { key: r.did },
              hx('td', { className: 'mono' }, fmtDID(r.did)),
              hx('td', null, r.area),
              hx('td', null, sparkline(t.pts, { c: t.relPct < 0 ? '#9b1c1c' : '#3f7d12' })),
              hx('td', { className: 'num' }, pfmt(t.first.cr)),
              hx('td', { className: 'num' }, pfmt(t.last.cr)),
              hx('td', { className: 'num ' + (t.relPct < 0 ? 'dx-neg' : 'dx-pos') },
                 (t.relPct >= 0 ? '+' : '') + t.relPct.toFixed(0) + '%'),
              hx('td', { className: 'num' }, nfmt(r.calls)),
              hx('td', null, r.diag ? sevChip(r.diag, { sm: true }) : '—')))))));
}

// ══ 9. REPUTATION ════════════════════════════════════════════════════════════
// Carrier ground truth. This is the half of the model contact rate cannot see.
function ReputationView(props) {
  const { rows, repBy, onImport, onClear } = props;

  const withRep = rows.filter(r => r.diag && r.diag.rep && r.diag.rep.known);
  const flagged = withRep.filter(r => r.diag.rep.flagged === true);
  const clean   = withRep.filter(r => r.diag.rep.flagged === false);
  const cover   = rows.length ? (withRep.length / rows.length) * 100 : 0;

  // Which carriers are doing the flagging — the buy/rotation decision changes a
  // lot depending on whether it is one carrier or all of them.
  const byCarrier = {};
  for (const r of withRep) {
    for (const [ck, st] of Object.entries(r.diag.rep.carriers || {})) {
      const c = (byCarrier[ck] = byCarrier[ck] || { k: ck, l: CARRIER_LB[ck] || ck, flagged: 0, clean: 0 });
      if (st === 'flagged') c.flagged++; else c.clean++;
    }
  }
  const carriers = Object.values(byCarrier).sort((a, b) => b.flagged - a.flagged);
  const maxFlag = Math.max(1, ...carriers.map(c => c.flagged));

  // Freshness — a six-week-old scan is not ground truth any more.
  const stamps = withRep.map(r => r.diag.rep.at).filter(Boolean);
  const newest = stamps.length ? Math.max(...stamps) : null;
  const oldest = stamps.length ? Math.min(...stamps) : null;

  const vendorCount = {};
  for (const r of withRep) for (const v of r.diag.rep.vendors) vendorCount[v] = (vendorCount[v] || 0) + 1;

  return hx('div', null,
    hx('div', { className: 'dx-note' },
      hx('i', { className: 'ti ti-shield-check' }),
      hx('div', null,
        hx('b', null, 'Any source reporting a flag counts as flagged. '),
        'These tools each see a different slice of the carrier ecosystem, so a "clean" from one is not a '
        + 'clean from all — but a "flagged" from one is real. The union is the honest read, and a number '
        + 'with no scan on record is shown as unknown rather than assumed clean.')),

    hx('div', { className: 'dx-kpis' },
      hx('div', { className: 'dx-kpi' },
        hx('div', { className: 'dx-kpi-l' }, 'Flagged'),
        hx('div', { className: 'dx-kpi-v', style: { color: '#9b1c1c' } }, nfmt(flagged.length)),
        hx('div', { className: 'dx-kpi-d' }, flagged.reduce((a, r) => a + (r.calls || 0), 0).toLocaleString() + ' calls exposed')),
      hx('div', { className: 'dx-kpi' },
        hx('div', { className: 'dx-kpi-l' }, 'Confirmed clean'),
        hx('div', { className: 'dx-kpi-v', style: { color: '#3f7d12' } }, nfmt(clean.length)),
        hx('div', { className: 'dx-kpi-d' }, 'carrier-verified')),
      hx('div', { className: 'dx-kpi' },
        hx('div', { className: 'dx-kpi-l' }, 'Coverage'),
        hx('div', { className: 'dx-kpi-v' }, cover.toFixed(0) + '%'),
        hx('div', { className: 'dx-kpi-d' }, nfmt(rows.length - withRep.length) + ' never scanned')),
      hx('div', { className: 'dx-kpi' },
        hx('div', { className: 'dx-kpi-l' }, 'Freshest scan'),
        hx('div', { className: 'dx-kpi-v', style: { fontSize: 18 } }, daysAgo(newest)),
        hx('div', { className: 'dx-kpi-d' }, oldest ? 'oldest ' + daysAgo(oldest) : '')),
    ),

    hx('div', { className: 'dx-imp' },
      hx('div', { className: 'dx-imp-h' },
        hx('i', { className: 'ti ti-download' }), 'Import reputation data'),
      hx('div', { className: 'dx-imp-s' },
        'Drop a CSV export, or copy the results table straight out of the tool and paste it below. '
        + 'Columns are matched by meaning, not by exact name, so an export that gets renamed still lands.'),
      hx('div', { className: 'dx-vendors' },
        REP_VENDORS.filter(v => v.id !== 'other').map(v => hx('span', { key: v.id, className: 'dx-vendor' },
          hx('i', { className: 'ti ' + v.i }), v.l,
          vendorCount[v.id] ? hx('b', null, vendorCount[v.id].toLocaleString()) : hx('em', null, 'none yet')))),
      hx('button', { className: 'dx-btn dx-btn-p', onClick: onImport },
        hx('i', { className: 'ti ti-file-import' }), 'Import / paste reputation data'),
      withRep.length > 0 && hx('button', { className: 'dx-btn', onClick: onClear },
        hx('i', { className: 'ti ti-trash' }), 'Clear reputation data')),

    carriers.length > 0 && hx('div', { className: 'dx-sec' },
      hx('div', { className: 'dx-sec-h' }, 'Who is flagging you'),
      hx('table', { className: 'dx-table' },
        hx('thead', null, hx('tr', null,
          hx('th', null, 'Carrier / database'), hx('th', { className: 'num' }, 'Flagged'),
          hx('th', { className: 'num' }, 'Clean'), hx('th', { className: 'num' }, 'Flag rate'), hx('th', null, ''))),
        hx('tbody', null, carriers.map(c => {
          const tot = c.flagged + c.clean;
          return hx('tr', { key: c.k },
            hx('td', null, c.l),
            hx('td', { className: 'num' }, nfmt(c.flagged)),
            hx('td', { className: 'num' }, nfmt(c.clean)),
            hx('td', { className: 'num' }, tot ? ((c.flagged / tot) * 100).toFixed(0) + '%' : '—'),
            hx('td', { style: { width: '38%' } }, magBar(c.flagged, maxFlag, '#9b1c1c')));
        })))),

    flagged.length > 0 && hx('div', { className: 'dx-sec' },
      hx('div', { className: 'dx-sec-h' }, 'Flagged numbers — ' + flagged.length),
      hx('table', { className: 'dx-table' },
        hx('thead', null, hx('tr', null,
          hx('th', null, 'Number'), hx('th', null, 'Area'), hx('th', { className: 'num' }, 'Calls'),
          hx('th', { className: 'num' }, 'Contact'), hx('th', null, 'Flagged by'),
          hx('th', null, 'Carriers'), hx('th', null, 'Verdict'))),
        hx('tbody', null, [...flagged].sort((a, b) => (b.calls || 0) - (a.calls || 0)).slice(0, 60)
          .map(r => hx('tr', { key: r.did },
            hx('td', { className: 'mono' }, fmtDID(r.did)),
            hx('td', null, r.area),
            hx('td', { className: 'num' }, nfmt(r.calls)),
            hx('td', { className: 'num' }, pfmt(r.cr)),
            hx('td', null, (r.diag.rep.flaggedBy || []).join(', ') || '—'),
            hx('td', null, (r.diag.rep.flaggedCarriers || []).map(c => CARRIER_LB[c] || c).join(', ') || '—'),
            hx('td', null, sevChip(r.diag, { sm: true })))))),
      flagged.length > 60 && hx('div', { className: 'dx-more' }, 'Showing the 60 highest-volume of ' + flagged.length + '.')),

    !withRep.length && hx('div', { className: 'dx-empty dx-empty-lg' },
      hx('i', { className: 'ti ti-shield-question' }),
      hx('div', { className: 'dx-empty-t' }, 'No reputation data yet'),
      hx('div', { className: 'dx-empty-s' },
        'Until a scan is imported, every spam verdict in this dashboard is INFERRED from contact rate — '
        + 'which cannot tell a burned number apart from a bad list. Importing one export from any of the four '
        + 'tools above changes that for every number it covers.')));
}

// ══ 10. BUY LIST — where to add numbers, and how many ═════════════════════════
function BuyListView(props) {
  const { rows, ctx } = props;
  const [target, setTarget] = React.useState(BUY_TARGET_DEFAULT);

  const all = buyList(rows, ctx, target);
  const need = all.filter(a => !a.lowData && a.need > 0);
  const watch = all.filter(a => !a.lowData && a.need === 0 && a.bad > 0);
  const thin = all.filter(a => a.lowData);
  const totalNeed = need.reduce((a, x) => a + x.need, 0);
  const maxPri = Math.max(1, ...need.map(a => a.priority));

  const acTable = (list, showNeed) => hx('table', { className: 'dx-table' },
    hx('thead', null, hx('tr', null,
      hx('th', null, 'Area'), hx('th', null, 'Location'),
      hx('th', { className: 'num' }, 'Numbers'), hx('th', { className: 'num' }, 'Working'),
      hx('th', { className: 'num' }, 'Calls'), hx('th', { className: 'num' }, 'Per working #'),
      hx('th', { className: 'num' }, 'Median contact'),
      showNeed ? hx('th', { className: 'num' }, 'Buy') : hx('th', { className: 'num' }, 'Damaged'),
      hx('th', null, showNeed ? 'Priority' : ''))),
    hx('tbody', null, list.map(a => hx('tr', { key: a.code },
      hx('td', { className: 'mono' }, a.code),
      hx('td', null, a.label),
      hx('td', { className: 'num' }, a.dids),
      hx('td', { className: 'num' }, a.working),
      hx('td', { className: 'num' }, nfmt(a.calls)),
      hx('td', { className: 'num' }, isFinite(a.depth) ? nfmt(a.depth) : '—'),
      hx('td', { className: 'num' }, pfmt(a.medCr)),
      showNeed
        ? hx('td', { className: 'num' }, hx('span', { className: 'dx-need' }, '+' + a.need))
        : hx('td', { className: 'num' }, a.bad),
      hx('td', null, showNeed ? magBar(a.priority, maxPri, '#d97706') : ''))))); 

  return hx('div', null,
    hx('div', { className: 'dx-note' },
      hx('i', { className: 'ti ti-map-pin' }),
      hx('div', null,
        hx('b', null, 'Area codes cannot be shopped around. '),
        'The lead dictates the area code, so the only lever is DEPTH — how many working numbers carry that '
        + 'area code’s volume. "Working" excludes anything currently diagnosed burned, collapsing, damaged, '
        + 'flagged or under DNC pressure, because those numbers are already costing contact rate. '
        + 'Buy counts are the numbers needed to bring volume per working number down to your target.')),

    hx('div', { className: 'dx-target' },
      hx('label', null, 'Target calls per working number'),
      hx('input', { type: 'range', min: 50, max: 600, step: 25, value: target,
                    onChange: e => setTarget(parseInt(e.target.value, 10)) }),
      hx('b', null, target),
      hx('span', { className: 'dx-target-s' },
        'Lower target = more numbers, less exposure each. Slide it to see how the buy changes.')),

    need.length > 0 && hx('div', { className: 'dx-hero dx-hero-warn' },
      hx('i', { className: 'ti ti-shopping-cart' }),
      hx('div', null,
        hx('div', { className: 'dx-hero-line' },
          'Buy ' + totalNeed + ' number' + (totalNeed === 1 ? '' : 's') + ' across ' + need.length
          + ' area code' + (need.length === 1 ? '' : 's') + '.'),
        hx('div', { className: 'dx-hero-sub' },
          'Ordered by exposed call volume, not by how bad the percentage looks — an area code with 4,000 calls '
          + 'and a third of its numbers damaged outranks one with 200 calls and all of them damaged.'))),

    need.length > 0 && hx('div', { className: 'dx-sec' },
      hx('div', { className: 'dx-sec-h' }, 'Beef these up'), acTable(need, true)),

    watch.length > 0 && hx('div', { className: 'dx-sec' },
      hx('div', { className: 'dx-sec-h' }, 'Deep enough, but carrying damage'),
      hx('div', { className: 'dx-sec-s' },
        'Enough numbers for the volume, but some are damaged. Replace rather than add — buying here adds cost without adding reach.'),
      acTable(watch, false)),

    thin.length > 0 && hx('div', { className: 'dx-sec' },
      hx('div', { className: 'dx-sec-h' }, 'Not enough data to call — ' + thin.length + ' area codes'),
      hx('div', { className: 'dx-sec-s' },
        'Under ' + MIN_AC_DIDS + ' numbers or ' + MIN_AC_CALLS + ' calls. A purchase recommendation off this much '
        + 'data would be a guess wearing a number, so none is made. Shown so they are not invisible.'),
      hx('div', { className: 'dx-thin' }, thin.map(a => hx('span', { key: a.code, className: 'dx-thin-c' },
        hx('b', null, a.code), a.dids + '#', nfmt(a.calls) + ' calls')))),

    !need.length && !watch.length && !thin.length && hx('div', { className: 'dx-empty dx-empty-lg' },
      hx('i', { className: 'ti ti-inbox' }),
      hx('div', { className: 'dx-empty-t' }, 'No area codes to act on'),
      hx('div', { className: 'dx-empty-s' }, 'Import a Contact Rate Report to populate this.')));
}

// ══ 11. REPUTATION IMPORT MODAL ══════════════════════════════════════════════
// Two ways in, because the four tools do not behave the same way:
//   FILE  — a CSV/TSV export, which every one of them can produce.
//   PASTE — select the results table in the tool's own UI, copy, paste here.
//           This is what makes "just scrape it" workable with no credentials,
//           no backend and no CORS problem: the browser you are already logged
//           into does the reading, and only the result crosses over.
function RepImport(props) {
  const { onClose, onDone } = props;
  const [raw, setRaw]       = React.useState('');
  const [fname, setFname]   = React.useState('');
  const [parsed, setParsed] = React.useState(null);   // { headers, rows }
  const [vendor, setVendor] = React.useState('other');
  const [cols, setCols]     = React.useState(null);
  const [err, setErr]       = React.useState('');
  const fileRef = React.useRef(null);

  function ingest(text, name, htmlFlavour) {
    setErr('');
    const p = htmlFlavour ? parsePasted(htmlFlavour, text) : parseRepText(text);
    if (!p.headers.length || !p.rows.length) {
      setErr('Could not find a table in that. Make sure the first line is the header row.');
      setParsed(null); return;
    }
    const v = detectVendor(p.headers, name);
    const c = detectRepCols(p.headers);
    if (!c.phone) {
      setErr('No phone-number column found. Columns seen: ' + p.headers.slice(0, 12).join(', '));
      setParsed(p); setCols(c); setVendor(v); return;
    }
    setParsed(p); setCols(c); setVendor(v); setFname(name || '');
  }

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => { setRaw(String(ev.target.result || '')); ingest(String(ev.target.result || ''), f.name); };
    rd.readAsText(f);
  }

  const records = (parsed && cols && cols.phone) ? buildRepRecords(parsed.rows, cols, vendor) : [];
  const flaggedN = records.filter(r => r.flagged === true).length;
  const cleanN   = records.filter(r => r.flagged === false).length;
  const unkN     = records.filter(r => r.flagged === null).length;

  function commit() {
    if (!records.length) return;
    const res = repStore.merge(records, vendor);
    onDone(res, vendor, records.length);
  }

  const colRow = (lb, key) => hx('div', { className: 'dx-map-row' },
    hx('span', { className: 'dx-map-l' }, lb),
    hx('select', {
      value: cols[key] || '',
      onChange: e => setCols({ ...cols, [key]: e.target.value }),
    },
      hx('option', { value: '' }, '— none —'),
      parsed.headers.map(hdr => hx('option', { key: hdr, value: hdr }, hdr))));

  return hx('div', { className: 'dx-modal-bg', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    hx('div', { className: 'dx-modal' },
      hx('div', { className: 'dx-modal-h' },
        hx('span', null, hx('i', { className: 'ti ti-shield-check' }), ' Import reputation data'),
        hx('button', { className: 'dx-x', onClick: onClose }, hx('i', { className: 'ti ti-x' }))),

      hx('div', { className: 'dx-modal-b' },
        !parsed && hx('div', null,
          hx('div', { className: 'dx-how' },
            hx('b', null, 'Option 1 — export a file.'),
            ' Any CSV or TSV from Convoso Ignite, CallPurity, DNC.com or Caller ID Reputation. '
            + 'Columns are matched by meaning, so a renamed export still works.'),
          hx('button', { className: 'dx-btn dx-btn-p', onClick: () => fileRef.current && fileRef.current.click() },
            hx('i', { className: 'ti ti-file-upload' }), 'Choose a CSV / TSV file'),
          hx('input', { ref: fileRef, type: 'file', accept: '.csv,.tsv,.txt', style: { display: 'none' }, onChange: onFile }),

          hx('div', { className: 'dx-how', style: { marginTop: 16 } },
            hx('b', null, 'Option 2 — copy the table out of the tool.'),
            ' Open the number list in Ignite / CallPurity / DNC.com / Caller ID Reputation, select the table '
            + '(header row included), copy, and paste below. Your browser is already logged in, so nothing '
            + 'needs a password or an API key here.'),
          hx('textarea', {
            className: 'dx-paste', value: raw, placeholder: 'Paste the copied table here…',
            onChange: e => setRaw(e.target.value),
            onPaste: e => {
              const cb = e.clipboardData || window.clipboardData;
              const t = cb.getData('text');
              // The HTML flavour carries the real table structure; plain text is
              // whatever the page's whitespace collapsed to. Prefer the former.
              let htmlFlavour = '';
              try { htmlFlavour = cb.getData('text/html') || ''; } catch (ex) { htmlFlavour = ''; }
              if (t || htmlFlavour) {
                e.preventDefault();
                setRaw(t || '(table pasted from the page)');
                ingest(t, 'pasted', htmlFlavour);
              }
            },
          }),
          raw && !parsed && hx('button', { className: 'dx-btn dx-btn-p', onClick: () => ingest(raw, 'pasted') },
            hx('i', { className: 'ti ti-wand' }), 'Read this table'),
          err && hx('div', { className: 'dx-err' }, hx('i', { className: 'ti ti-alert-circle' }), err)),

        parsed && hx('div', null,
          err && hx('div', { className: 'dx-err' }, hx('i', { className: 'ti ti-alert-circle' }), err),
          hx('div', { className: 'dx-src' },
            hx('span', null, 'Source'),
            hx('select', { value: vendor, onChange: e => setVendor(e.target.value) },
              REP_VENDORS.map(v => hx('option', { key: v.id, value: v.id }, v.l))),
            hx('span', { className: 'dx-src-s' },
              fname ? fname + ' · ' : '', parsed.rows.length.toLocaleString() + ' rows read')),

          hx('div', { className: 'dx-map' },
            hx('div', { className: 'dx-map-h' }, 'Columns detected — change any that look wrong'),
            colRow('Phone number', 'phone'),
            colRow('Flagged / status', 'flag'),
            colRow('Reputation score', 'score'),
            colRow('Displayed label', 'label'),
            colRow('Last checked', 'date'),
            colRow('Remediation status', 'status'),
            Object.keys(cols.carriers).length > 0 && hx('div', { className: 'dx-map-car' },
              hx('b', null, 'Per-carrier columns found: '),
              Object.entries(cols.carriers).map(([k, hdr]) =>
                hx('span', { key: k, className: 'dx-map-chip' }, (CARRIER_LB[k] || k) + ' ← ' + hdr)))),

          hx('div', { className: 'dx-sum' },
            hx('div', null, hx('b', { style: { color: '#9b1c1c' } }, flaggedN), ' flagged'),
            hx('div', null, hx('b', { style: { color: '#3f7d12' } }, cleanN), ' clean'),
            hx('div', null, hx('b', { style: { color: '#6b7280' } }, unkN), ' unreadable'),
            hx('div', null, hx('b', null, records.length), ' numbers total')),

          records.length > 0 && hx('div', { className: 'dx-prev' },
            hx('table', { className: 'dx-table' },
              hx('thead', null, hx('tr', null,
                hx('th', null, 'Number'), hx('th', null, 'Verdict'),
                hx('th', { className: 'num' }, 'Score'), hx('th', null, 'Label'), hx('th', null, 'Carriers'))),
              hx('tbody', null, records.slice(0, 8).map((r, i) => hx('tr', { key: i },
                hx('td', { className: 'mono' }, fmtDID(r.phone)),
                hx('td', null, r.flagged === true ? hx('b', { style: { color: '#9b1c1c' } }, 'Flagged')
                             : r.flagged === false ? hx('span', { style: { color: '#3f7d12' } }, 'Clean')
                             : hx('span', { style: { color: '#6b7280' } }, 'Unknown')),
                hx('td', { className: 'num' }, r.score === null ? '—' : r.score),
                hx('td', null, r.label || '—'),
                hx('td', null, Object.entries(r.carriers).filter(([, s]) => s === 'flagged')
                                 .map(([k]) => CARRIER_LB[k] || k).join(', ') || '—')))))))),

      hx('div', { className: 'dx-modal-f' },
        parsed && hx('button', { className: 'dx-btn', onClick: () => { setParsed(null); setRaw(''); setErr(''); } },
          hx('i', { className: 'ti ti-arrow-left' }), 'Start over'),
        hx('button', { className: 'dx-btn', onClick: onClose }, 'Cancel'),
        hx('button', { className: 'dx-btn dx-btn-p', disabled: !records.length, onClick: commit },
          hx('i', { className: 'ti ti-check' }),
          records.length ? 'Import ' + records.length.toLocaleString() + ' numbers' : 'Nothing to import'))));
}

// ══ 12. CLIPBOARD HTML ═══════════════════════════════════════════════════════
// When you select a table in a web page and copy it, the browser puts BOTH
// text/plain and text/html on the clipboard. The plain-text flavour is whatever
// the page's whitespace happened to collapse to — ragged, sometimes with the
// columns run together. The HTML flavour is the actual table structure.
//
// Reading the HTML flavour is what makes "copy it out of Ignite and paste it
// here" reliable rather than hit-and-miss, and it is the only ingest path
// available when a tool offers no export at all.

function stripTags(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ').trim();
}

// Pull the first real table out of clipboard HTML. Uses DOMParser in the browser
// and a tag-scanning fallback elsewhere (which is also what the tests exercise).
function htmlTableToGrid(html) {
  if (!html || !/<t[rd]/i.test(html)) return null;
  let rows = null;
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // Deepest-first: some tools wrap the real table in layout tables.
      const tables = Array.from(doc.querySelectorAll('table'));
      const best = tables.sort((a, b) =>
        b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
      if (best) {
        rows = Array.from(best.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('th,td')).map(c => stripTags(c.innerHTML)));
      }
    } catch (e) { rows = null; }
  }
  if (!rows) {
    rows = (html.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(tr =>
      (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(c => stripTags(c)));
  }
  rows = rows.filter(r => r.length && r.some(c => c !== ''));
  if (rows.length < 2) return null;

  // Skip any title/toolbar rows above the real header: the header is the first
  // row whose width matches the body's most common width.
  const widths = {};
  rows.forEach(r => { widths[r.length] = (widths[r.length] || 0) + 1; });
  const modal = +Object.entries(widths).sort((a, b) => b[1] - a[1])[0][0];
  const start = rows.findIndex(r => r.length === modal);
  const grid = rows.slice(start < 0 ? 0 : start).filter(r => r.length === modal);
  if (grid.length < 2) return null;

  const headers = grid[0].map((hdr, i) => hdr || ('__col_' + i + '__'));
  const out = grid.slice(1).map(r => {
    const o = {};
    headers.forEach((hdr, i) => { o[hdr] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
  return { headers, rows: out };
}

// One entry point for every paste: HTML table first, delimited text second.
function parsePasted(htmlFlavour, textFlavour) {
  const g = htmlTableToGrid(htmlFlavour);
  if (g && g.headers.length) return g;
  return parseRepText(textFlavour);
}

// ══ 13. HISTORY BACK-FILL ════════════════════════════════════════════════════
// Trends need two observations. Without back-fill the tab is empty until the
// NEXT import and useful only after the one after that. Saved Convoso exports
// already contain that history — they just need dating and replaying.
//
// Back-fill writes SNAPSHOTS ONLY. It never touches the live pool, so replaying
// six months of old reports cannot disturb the current one.

// Find the report date in a filename. Convoso exports and hand-saved files use
// a handful of shapes; anything unrecognised is left for the user to set.
function dateFromName(name) {
  const n = String(name || '');
  let m;
  if ((m = n.match(/(20\d{2})[-_./]?(\d{2})[-_./]?(\d{2})/)))            // 2026-09-14
    return Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00`) || null;
  if ((m = n.match(/(\d{1,2})[-_./](\d{1,2})[-_./](20\d{2})/))) {        // 9-14-2026
    const mm = String(m[1]).padStart(2, '0'), dd = String(m[2]).padStart(2, '0');
    return Date.parse(`${m[3]}-${mm}-${dd}T12:00:00`) || null;
  }
  return null;
}

// Write a snapshot AT a given date, keeping the list ordered and merging any
// existing snapshot for that same day.
snapStore.recordAt = function (rows, fname, when) {
  if (!rows || !rows.length) return snapStore.load();
  const day = dayKey(when);
  const obj = snapStore.load();
  const idx = obj.snaps.findIndex(s => s.day === day);
  const d = idx >= 0 ? { ...obj.snaps[idx].d } : {};
  for (const r of rows) {
    const p = canonPh(r.did);
    if (!p) continue;
    d[p] = [ +r.calls || 0, Math.round((+r.cr || 0) * 10) / 10, +r.dncCount || 0 ];
  }
  const entry = { t: when, day, f: fname || '', d };
  const snaps = idx >= 0
    ? obj.snaps.map((s, i) => (i === idx ? entry : s))
    : [...obj.snaps, entry];
  snaps.sort((a, b) => a.t - b.t);
  return snapStore.save({ v: 1, snaps });
};

// Parse one saved Convoso Contact Rate Report into snapshot rows, reusing
// app.js's own column detection so back-fill and live import agree exactly.
function parseConvosoReport(text) {
  const res = Papa.parse(String(text || '').trim(), {
    header: true, skipEmptyLines: true,
    transformHeader: (hdr, i) => (hdr && hdr.trim()) ? hdr : ('__col_' + i + '__'),
  });
  const headers = (res.meta && res.meta.fields) ? res.meta.fields : [];
  if (!headers.length) return { rows: [], headers: [], map: null };
  const map = autoDetect(headers);
  if (!map.did || !map.calls) return { rows: [], headers, map };
  const rows = (res.data || []).map(row => {
    const raw = String(row[map.did] || '').trim();
    if (!raw || raw.replace(/\D/g, '').length < 10) return null;
    return {
      did: canonPh(raw),
      calls: parseInt(row[map.calls]) || 0,
      cr: parseFloat(String(row[map.cr] || '').replace('%', '')) || 0,
      dncCount: map.dncCount ? (parseInt(row[map.dncCount]) || 0) : 0,
    };
  }).filter(Boolean);
  return { rows, headers, map };
}

// ── Back-fill modal ──────────────────────────────────────────────────────────
function BackfillImport(props) {
  const { onClose, onDone } = props;
  const [files, setFiles] = React.useState([]);   // {name, when, rows, err, id}
  const [busy, setBusy]   = React.useState(false);
  const fileRef = React.useRef(null);
  const uid = React.useRef(0);

  function addFiles(e) {
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    setBusy(true);
    let pending = list.length;
    const acc = [];
    list.forEach(f => {
      const rd = new FileReader();
      rd.onload = ev => {
        let parsed = { rows: [] }, err = '';
        try { parsed = parseConvosoReport(String(ev.target.result || '')); }
        catch (ex) { err = 'Could not read this file.'; }
        if (!err && !parsed.rows.length) {
          err = parsed.headers && parsed.headers.length
            ? 'No DID/Calls columns found. Saw: ' + parsed.headers.slice(0, 6).join(', ')
            : 'No table found in this file.';
        }
        acc.push({ id: ++uid.current, name: f.name, when: dateFromName(f.name) || f.lastModified || Date.now(),
                   dated: !!dateFromName(f.name), rows: parsed.rows, err });
        if (--pending === 0) {
          acc.sort((a, b) => a.when - b.when);
          setFiles(prev => [...prev, ...acc].sort((a, b) => a.when - b.when));
          setBusy(false);
        }
      };
      rd.readAsText(f);
    });
    e.target.value = '';
  }

  const good = files.filter(f => !f.err && f.rows.length);
  // Two reports dated the same day collapse into one snapshot — say so before
  // the user commits, not after the count comes out short.
  const days = new Set(good.map(f => dayKey(f.when)));
  const collapsing = good.length - days.size;

  function commit() {
    let res = null;
    for (const f of good) res = snapStore.recordAt(f.rows, f.name, f.when);
    onDone(res || snapStore.load(), good.length, days.size);
  }

  const setWhen = (id, v) => setFiles(fs => fs.map(f =>
    f.id === id ? { ...f, when: Date.parse(v + 'T12:00:00') || f.when, dated: true } : f)
    .sort((a, b) => a.when - b.when));

  return hx('div', { className: 'dx-modal-bg', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    hx('div', { className: 'dx-modal' },
      hx('div', { className: 'dx-modal-h' },
        hx('span', null, hx('i', { className: 'ti ti-history' }), ' Back-fill history from saved reports'),
        hx('button', { className: 'dx-x', onClick: onClose }, hx('i', { className: 'ti ti-x' }))),

      hx('div', { className: 'dx-modal-b' },
        hx('div', { className: 'dx-how' },
          hx('b', null, 'Drop in your saved Convoso Contact Rate Reports. '),
          'Each one becomes a dated snapshot, so Trends works immediately instead of after '
          + 'your next two imports. Dates are read from the filename where possible — check '
          + 'every row below and correct any that are wrong, because the date is what the '
          + 'trend lines are plotted against.'),
        hx('div', { className: 'dx-note', style: { margin: '10px 0' } },
          hx('i', { className: 'ti ti-shield-check' }),
          hx('div', null, hx('b', null, 'This only writes history. '),
            'Your current pool is not touched, so replaying old reports cannot disturb what '
            + 'is on screen now. Re-running this is safe — a report dated the same day as an '
            + 'existing snapshot updates it rather than adding a duplicate.')),

        hx('button', { className: 'dx-btn dx-btn-p', onClick: () => fileRef.current && fileRef.current.click() },
          hx('i', { className: 'ti ti-files' }), files.length ? 'Add more reports' : 'Choose saved reports'),
        hx('input', { ref: fileRef, type: 'file', accept: '.csv,.tsv,.txt', multiple: true,
                      style: { display: 'none' }, onChange: addFiles }),
        busy && hx('span', { style: { marginLeft: 10, fontSize: 11.5, color: '#6b7280' } }, 'Reading…'),

        files.length > 0 && hx('table', { className: 'dx-table', style: { marginTop: 12 } },
          hx('thead', null, hx('tr', null,
            hx('th', null, 'File'), hx('th', null, 'Report date'),
            hx('th', { className: 'num' }, 'Numbers'), hx('th', null, ''))),
          hx('tbody', null, files.map(f => hx('tr', { key: f.id },
            hx('td', null, f.name),
            hx('td', null, hx('input', {
              type: 'date', className: 'dx-date',
              value: new Date(f.when).toISOString().slice(0, 10),
              onChange: e => setWhen(f.id, e.target.value),
            }), !f.dated && !f.err && hx('span', { className: 'dx-guess' }, 'guessed')),
            hx('td', { className: 'num' }, f.err ? '—' : f.rows.length.toLocaleString()),
            hx('td', null, f.err
              ? hx('span', { style: { color: '#9b1c1c', fontSize: 10.5 } }, f.err)
              : hx('button', { className: 'dx-x', title: 'Remove',
                    onClick: () => setFiles(fs => fs.filter(x => x.id !== f.id)) },
                  hx('i', { className: 'ti ti-trash' }))))))),

        good.length > 0 && hx('div', { className: 'dx-sum', style: { marginTop: 12 } },
          hx('div', null, hx('b', null, good.length), ' reports ready'),
          hx('div', null, hx('b', null, days.size), ' snapshot days'),
          collapsing > 0 && hx('div', { style: { color: '#b45309' } },
            hx('i', { className: 'ti ti-alert-triangle' }),
            ' ' + collapsing + ' share a date with another and will merge')),

        files.length === 0 && hx('div', { className: 'dx-empty', style: { marginTop: 14 } },
          hx('i', { className: 'ti ti-file-search' }),
          hx('div', null, 'No reports added yet. You can select several at once.'))),

      hx('div', { className: 'dx-modal-f' },
        hx('button', { className: 'dx-btn', onClick: onClose }, 'Cancel'),
        hx('button', { className: 'dx-btn dx-btn-p', disabled: !good.length, onClick: commit },
          hx('i', { className: 'ti ti-check' }),
          good.length ? 'Back-fill ' + days.size + ' day' + (days.size === 1 ? '' : 's') : 'Nothing to add'))));
}
