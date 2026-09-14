let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  PASS  '+m);} else {fail++;console.log('  FAIL  '+m);} };
const eq=(a,b,m)=>ok(JSON.stringify(a)===JSON.stringify(b), m+`  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const D=86400000, NOW=Date.now();

console.log('\n=== 1. SNAPSHOT STORE ===');
// Same-day imports must MERGE (Southern export then Northern export on one day).
snapStore.record([{did:'12015551111',calls:100,cr:20,dncCount:0}], 'south.csv');
snapStore.record([{did:'12015552222',calls:200,cr:15,dncCount:3}], 'north.csv');
let s1 = snapStore.load();
eq(s1.snaps.length, 1, 'same-day imports collapse to one snapshot');
eq(Object.keys(s1.snaps[0].d).sort(), ['2015551111','2015552222'], 'same-day merge keeps BOTH centers (no clobber)');
// Re-importing the same number the same day updates it rather than duplicating.
snapStore.record([{did:'12015551111',calls:140,cr:18,dncCount:1}], 'south2.csv');
s1 = snapStore.load();
eq(s1.snaps[0].d['2015551111'], [140,18,1], 'same-day re-import updates in place');
eq(s1.snaps.length, 1, 'still one snapshot for the day');

console.log('\n=== 2. TREND MATH ===');
const mk=(days,cr,calls)=>({t:NOW-days*D, day:'d', f:'', d:{'2015551111':[calls||300,cr,0]}});
const collapsing=[mk(28,30),mk(14,22),mk(0,14)];
let t = trendFor('12015551111', collapsing);
ok(t.ok, 'trend computed with 3 points');
eq(t.dir, 'collapsing', '30%->14% over 28d reads as collapsing');
ok(Math.abs(t.relPct - (-53.33)) < 0.1, 'relative drop ~-53% (got '+t.relPct.toFixed(2)+')');
ok(t.perWeek < 0, 'weekly slope is negative (got '+t.perWeek.toFixed(2)+')');
// The guard that stops tiny numbers from faking a crisis.
t = trendFor('12015551111', [mk(14,0.4),mk(0,0.3)]);
eq(t.dir, 'flat', '0.4%->0.3% is NOT a 25% collapse (absolute guard holds)');
// Rising
t = trendFor('12015551111', [mk(14,10),mk(0,18)]);
eq(t.dir, 'rising', '10%->18% reads as rising');
// Single observation
t = trendFor('12015559999', collapsing);
eq(t.ok, false, 'unknown number returns no trend rather than throwing');

console.log('\n=== 3. VENDOR REPUTATION ADAPTERS ===');
const vend = (name, csv, expectVendor) => {
  const p = parseRepText(csv);
  const v = detectVendor(p.headers, name);
  const c = detectRepCols(p.headers);
  const recs = buildRepRecords(p.rows, c, v);
  console.log(`  -- ${name}: vendor=${v} phoneCol="${c.phone}" rows=${recs.length} carriers=${Object.keys(c.carriers).join('|')||'none'}`);
  ok(v === expectVendor, `${name} detected as ${expectVendor}`);
  ok(recs.length > 0, `${name} produced records`);
  return recs;
};
// Ignite: 1-100 health score, no explicit flag column.
let r = vend('ignite_export.csv',
  'Phone Number,Ignite Score,Last Checked\n2015551111,18,2026-09-10\n2015552222,91,2026-09-10\n', 'ignite');
eq(r[0].flagged, true,  'Ignite score 18 -> flagged (bottom third)');
eq(r[1].flagged, false, 'Ignite score 91 -> clean');
// Caller ID Reputation: per-carrier spam labels.
r = vend('calleridreputation.csv',
  'Number,AT&T,T-Mobile,Verizon,Caller ID Name\n2015551111,Spam Likely,Clean,Scam Likely,SPAM\n', 'calleridrep');
eq(r[0].flagged, true, 'Caller ID Rep: any carrier flag -> flagged');
eq(r[0].carriers, {att:'flagged',tmobile:'clean',verizon:'flagged'}, 'per-carrier states parsed individually');
// CallPurity: remediation workflow.
r = vend('callpurity_numbers.csv',
  'DID,Status,Remediation Status\n2015551111,Flagged,Submitted\n2015553333,Clean,\n', 'callpurity');
eq(r[0].flagged, true,  'CallPurity Flagged -> true');
eq(r[1].flagged, false, 'CallPurity Clean -> false');
eq(r[0].status, 'Submitted', 'remediation status captured');
// DNC.com: litigator / scrub risk.
r = vend('dnc.com_scrub.csv',
  'Phone,DNC Status,Litigator\n2015554444,Yes,No\n', 'dnccom');
eq(r[0].flagged, true, 'DNC.com Yes -> flagged');
// Unknown vendor still imports — semantic fallback.
r = vend('some_random_tool.csv', 'tn,spam_flag\n2015555555,true\n', 'other');
eq(r[0].flagged, true, 'unknown vendor falls back to semantics, still imports');
// TSV paste straight out of a web UI.
const pasted = parseRepText('Number\tStatus\n(201) 555-1111\tSpam\n');
ok(pasted.headers.length === 2, 'pasted TSV parsed (tab delimiter auto-detected)');
const pr = buildRepRecords(pasted.rows, detectRepCols(pasted.headers), 'other');
eq(pr[0].phone, '2015551111', 'formatted phone from a pasted table is normalized');

console.log('\n=== 4. REPUTATION ROLL-UP ===');
repStore.clear();
repStore.merge([{phone:'2015551111',flagged:false,score:80,carriers:{att:'clean'}}], 'ignite');
repStore.merge([{phone:'2015551111',flagged:true,score:null,carriers:{tmobile:'flagged'}}], 'calleridrep');
let rep = repOf('12015551111', repStore.load().byPhone);
eq(rep.flagged, true, 'one source flagging beats another saying clean (union)');
eq(rep.flaggedBy, ['Caller ID Reputation'], 'names which source flagged it');
eq(rep.vendors.sort(), ['calleridrep','ignite'], 'both vendors retained, not overwritten');
// 11-digit vs 10-digit join key
repStore.merge([{phone:'12015558888',flagged:true,carriers:{}}], 'callpurity');
eq(repOf('2015558888', repStore.load().byPhone).flagged, true, '1-prefixed and bare numbers join to the same record');
eq(repOf('2015550000', repStore.load().byPhone).known, false, 'never-scanned number is unknown, NOT assumed clean');

console.log('\n=== 5. DIAGNOSIS ENGINE (the two-axis model) ===');
// A believable area code: 8 numbers, median contact rate 20%.
const mkDid=(did,cr,calls,dnc)=>({did, area:did.substring(1,4), cr, calls, dncCount:dnc||0});
const pool = [
  mkDid('12015551111',20,300), mkDid('12015552222',21,300), mkDid('12015553333',19,300),
  mkDid('12015554444',22,300), mkDid('12015555555',18,300), mkDid('12015556666',20,300),
  mkDid('12015557777',21,300), mkDid('12015558888',20,300),
];
repStore.clear();
let ctx = buildCtx(pool, {}, []);
ok(Math.abs(ctx.acMed['201'] - 20) < 0.6, 'area-code median computed (~20%, got '+ctx.acMed['201'].toFixed(1)+')');

// (a) Low contact rate, carriers say CLEAN -> list problem, NOT a replacement.
repStore.clear();
repStore.merge([{phone:'2015559999',flagged:false,carriers:{att:'clean',tmobile:'clean'}}],'calleridrep');
let by = repStore.load().byPhone;
let c1 = buildCtx([...pool, mkDid('12015559999',7,300)], by, []);
let dClean = classify(mkDid('12015559999',7,300), c1);
eq(dClean.key, 'list_problem', 'clean with carriers + 7% CR -> LIST problem (do not replace)');
// Assert the INTENT (steer away from replacement, point at the list), not one phrasing.
ok(/list/i.test(dClean.act), 'its action points at the list');
ok(!/queue for replacement|replace it\b/i.test(dClean.act), 'its action never instructs a replacement');
ok(dClean.sev < DIAGS.damaged.sev, 'and it is ranked below "damaged" so it does not reach the buy list');

// (b) Same terrible numbers, but carriers ARE flagging -> burned.
repStore.clear();
repStore.merge([{phone:'2015559999',flagged:true,carriers:{att:'flagged'}}],'calleridrep');
by = repStore.load().byPhone;
let c2 = buildCtx([...pool, mkDid('12015559999',7,300)], by, []);
let dBurn = classify(mkDid('12015559999',7,300), c2);
eq(dBurn.key, 'burned', 'IDENTICAL performance + carrier flag -> BURNED (replace)');
ok(dBurn.sev > dClean.sev, 'burned outranks list-problem in severity');
console.log('  >> Same 7% contact rate, opposite verdicts. That is the whole point.');

// (c) No reputation data at all -> honest "unscanned", never a false verdict.
let c3 = buildCtx([...pool, mkDid('12015559999',7,300)], {}, []);
let dUnscanned = classify(mkDid('12015559999',7,300), c3);
eq(dUnscanned.key, 'damaged', 'no scan -> in-area comparison still stands (damaged)');
ok(/scan it before spending money/i.test(dUnscanned.act), 'but it says to scan before buying a replacement');
eq(classify(mkDid('12015551111',9,300), buildCtx([mkDid('12015551111',9,300)],{},[])).key, 'unknown_low',
   'low CR with too few area-code peers to compare -> unscanned, not a guess');

// (d) Under 25 calls is never judged.
eq(classify(mkDid('12015550000',3,10), c3).key, 'nodata', 'under 25 calls -> no verdict');

// (e) Collapsing trend outranks a static read.
const cSnaps=[{t:NOW-21*D,day:'a',f:'',d:{'2015551111':[300,30,0]}},{t:NOW,day:'b',f:'',d:{'2015551111':[300,13,0]}}];
let c4 = buildCtx(pool, {}, cSnaps);
eq(classify(mkDid('12015551111',13,300), c4).key, 'collapsing', '30%->13% -> collapsing');

// (f) Existing DNC Alert rule preserved exactly (dnc>=4 && calls>50 && cr<=25).
eq(classify(mkDid('12015551111',20,300,5), buildCtx(pool,{},[])).key, 'dnc', 'DNC rule preserved (4+ DNC, 50+ calls, CR<=25)');

// (g) Damaged vs its OWN area code, region-neutral.
eq(classify(mkDid('12015551111',9,300), buildCtx(pool,{},[])).key, 'damaged', '9% vs 20% area median -> damaged');

// (h) Healthy stays healthy.
eq(classify(mkDid('12015551111',21,300), buildCtx(pool,{},[])).key, 'healthy', 'at-median number -> healthy');

console.log('\n=== 6. BUY LIST ===');
const withDiag = rs => { const c = buildCtx(rs, repStore.load().byPhone, []); return { rows: rs.map(d=>({...d, diag:classify(d,c)})), ctx:c }; };
repStore.clear();
// 4 numbers, 1200 calls, all healthy. At target 200 -> needs 6 total -> buy 2.
const acA = [mkDid('18135551111',20,300),mkDid('18135552222',21,300),mkDid('18135553333',20,300),mkDid('18135554444',19,300)];
let bl = buyList(withDiag(acA).rows, withDiag(acA).ctx, 200);
let a813 = bl.find(a=>a.code==='813');
eq(a813.working, 4, 'all four count as working');
eq(a813.need, 2, '1200 calls / 200 target = 6 needed, have 4 -> buy 2');
eq(a813.lowData, false, '4 numbers & 1200 calls clears the data minimums');
// Halve the target -> more numbers needed.
eq(buyList(withDiag(acA).rows, withDiag(acA).ctx, 100).find(a=>a.code==='813').need, 8, 'target 100 -> buy 8');
// Thin area codes get no recommendation at all.
const thin = [mkDid('19045551111',20,60)];
eq(buyList(withDiag(thin).rows, withDiag(thin).ctx, 200).find(a=>a.code==='904').lowData, true,
   'below minimums -> flagged low-data, no purchase guess');
// Damaged numbers stop counting as capacity.
const acB = [mkDid('12105551111',20,300),mkDid('12105552222',21,300),mkDid('12105553333',20,300),
             mkDid('12105554444',20,300),mkDid('12105555555',20,300),mkDid('12105556666',20,300),
             mkDid('12105557777',3,300)];
const wB = withDiag(acB); let a210 = buyList(wB.rows, wB.ctx, 200).find(a=>a.code==='210');
ok(a210.bad >= 1, 'the 3% number is counted as damaged (bad='+a210.bad+')');
eq(a210.working, acB.length - a210.bad, 'working excludes damaged numbers');

console.log('\n=== 7. POOL TREND ===');
const pt = poolTrend([
  {t:NOW-7*D,day:'a',f:'',d:{'2015551111':[100,20,1],'2015552222':[100,10,0]}},
  {t:NOW,     day:'b',f:'',d:{'2015551111':[100,30,2],'2015552222':[100,20,1]}},
]);
eq(pt.length, 2, 'one row per snapshot');
eq(pt[0].avgCr, 15, 'call-weighted pool contact rate (equal volume -> mean)');
eq(pt[1].avgCr, 25, 'pool rate rises on the later snapshot');
eq(pt[0].dnc1k, 5, 'DNC per 1k calls computed (1 DNC / 200 calls = 5)');
ok(pt[1].dnc1k === 15, 'DNC per 1k rises with more requests');

console.log('\n=== 8. EDGE CASES ===');
ok(trendFor('', []).ok === false, 'empty snapshot list does not throw');
ok(poolTrend([]).length === 0, 'poolTrend on no snapshots returns empty');
ok(buyList([], buildCtx([], {}, []), 200).length === 0, 'buyList on an empty pool returns empty');
eq(parseRepText('').headers, [], 'empty paste yields no headers, no throw');
eq(parseFlag(''), null, 'blank flag cell -> unknown, not false');
eq(parseFlag('Not Flagged'), false, '"Not Flagged" is clean, not a substring match on "flagged"');
eq(parseFlag('SPAM LIKELY'), true, 'case-insensitive flag match');
eq(canonPh('(201) 555-1111'), '2015551111', 'formatted number canonicalised');
eq(canonPh('12015551111'), '2015551111', '11-digit canonicalised');
eq(canonPh(null), '', 'null phone -> empty, no throw');
ok(classify({did:'12015551111',area:'201',cr:0,calls:0,dncCount:0}, buildCtx([],{},[])).key==='nodata','zero-call number handled');


console.log('\n=== 9. CLIPBOARD HTML (web-UI copy/paste) ===');
// What a browser actually puts on the clipboard when you select a table in a page.
const clipHtml = `<meta charset='utf-8'><table class="results">
<thead><tr><th>Phone Number</th><th>AT&amp;T</th><th>T-Mobile</th><th>Status</th></tr></thead>
<tbody>
<tr><td>(201)&nbsp;555-1111</td><td>Spam&nbsp;Likely</td><td>Clean</td><td>Flagged</td></tr>
<tr><td><span class="x">2015552222</span></td><td>Clean</td><td>Clean</td><td>Clean</td></tr>
</tbody></table>`;
let g = htmlTableToGrid(clipHtml);
ok(!!g, 'clipboard HTML table parsed');
eq(g.headers, ['Phone Number','AT&T','T-Mobile','Status'], 'headers decoded (entities unescaped)');
eq(g.rows.length, 2, 'both body rows extracted');
let hrecs = buildRepRecords(g.rows, detectRepCols(g.headers), 'calleridrep');
eq(hrecs[0].phone, '2015551111', 'nbsp/paren formatting stripped from the number');
eq(hrecs[0].flagged, true,  'row 1 flagged');
eq(hrecs[1].flagged, false, 'row 2 clean (nested span unwrapped)');
// A toolbar/title row above the header must not become the header.
g = htmlTableToGrid(`<table><tr><td colspan="2">My Numbers — export</td></tr>
<tr><th>DID</th><th>Status</th></tr><tr><td>2015553333</td><td>Spam</td></tr>
<tr><td>2015554444</td><td>Clean</td></tr></table>`);
eq(g.headers, ['DID','Status'], 'title row above the header is skipped');
eq(g.rows.length, 2, 'body rows survive the skip');
// parsePasted prefers HTML, falls back to text.
eq(parsePasted(clipHtml, 'junk').headers.length, 4, 'parsePasted prefers the HTML flavour');
eq(parsePasted('', 'A,B\n1,2\n').headers, ['A','B'], 'parsePasted falls back to delimited text');
eq(htmlTableToGrid('no tables here'), null, 'non-table HTML returns null, no throw');

console.log('\n=== 10. HISTORY BACK-FILL ===');
eq(dateFromName('contact_rate_2026-08-01.csv'), Date.parse('2026-08-01T12:00:00'), 'ISO date in filename');
eq(dateFromName('report 9-14-2026.csv'),        Date.parse('2026-09-14T12:00:00'), 'US date in filename');
eq(dateFromName('20260703_export.csv'),         Date.parse('2026-07-03T12:00:00'), 'compact date in filename');
eq(dateFromName('convoso_export.csv'), null, 'undated filename -> null (user sets it)');

// parseConvosoReport() depends on app.js's autoDetect(), so it is exercised in
// the integration suite where app.js is actually loaded.
snapStore.clear();
const AUG = Date.parse('2026-08-01T12:00:00'), SEP = Date.parse('2026-09-01T12:00:00');
const augRows=[{did:'12015551111',calls:300,cr:20,dncCount:1}];
snapStore.recordAt(augRows, 'aug.csv', SEP);                        // out of order on purpose
snapStore.recordAt([{did:'12015551111',calls:300,cr:30,dncCount:0}], 'jul.csv', AUG);
let sn = snapStore.load().snaps;
eq(sn.length, 2, 'two back-filled days');
ok(sn[0].t < sn[1].t, 'snapshots re-sorted into chronological order regardless of insert order');
eq(sn[0].day, '2026-08-01', 'earliest day first');
// Back-filled history is immediately readable as a trend.
let bt = trendFor('12015551111', snapStore.load().snaps);
ok(bt.ok, 'trend computable straight from back-filled data');
eq(bt.dir, 'falling', '30% -> 20% across back-filled months reads as falling');
// Re-running the same back-fill must not duplicate the day.
snapStore.recordAt(augRows, 'aug.csv', SEP);
eq(snapStore.load().snaps.length, 2, 're-running back-fill updates in place, no duplicate day');

console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);
process.exit(fail ? 1 : 0);
