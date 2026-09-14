const { renderToStaticMarkup } = require('react-dom/server');
let pass=0, fail=0;
const D=86400000, NOW=Date.now();
// Capture React's own warnings (bad keys, invalid props) and treat them as failures.
const warnings=[]; const _e=console.error, _w=console.warn;
console.error=(...a)=>warnings.push(a.join(' ')); console.warn=(...a)=>warnings.push(a.join(' '));
function render(name, el){
  try { const html = renderToStaticMarkup(el);
    if(!html || html.length<20) throw new Error('rendered empty ('+html.length+' chars)');
    pass++; _e(`  PASS  ${name}  (${html.length} chars)`); return html;
  } catch(e){ fail++; _e(`  FAIL  ${name}  -> ${e.message}`); return ''; }
}

// ── Realistic pool: two area codes, a burned number, a clean underperformer ──
const mk=(did,cr,calls,dnc,camp)=>({did,area:did.slice(1,4),cr,calls,dncCount:dnc||0,
  campaign:camp||'Southern Tier 2',center:'South',score:70,grade:'B',fmt:fmtDID(did)});
const pool=[];
for(let i=0;i<8;i++) pool.push(mk('1201555'+String(1000+i),19+(i%4),300+i*20,i%3===0?1:0));
for(let i=0;i<6;i++) pool.push(mk('1813555'+String(2000+i),21+(i%3),400+i*30,0));
pool.push(mk('12015559999',6,520,6));      // burned candidate
pool.push(mk('18135558888',5,480,0));      // clean underperformer
pool.push(mk('19045550001',12,8));         // below the 25-call floor

repStore.clear(); snapStore.clear();
repStore.merge([{phone:'2015559999',flagged:true,score:12,label:'Scam Likely',
                 carriers:{att:'flagged',tmobile:'flagged',verizon:'clean'}}],'calleridrep');
repStore.merge([{phone:'8135558888',flagged:false,score:88,carriers:{att:'clean',tmobile:'clean'}}],'ignite');
const repBy = repStore.load().byPhone;

// Three dated snapshots so trends are real.
const snaps=[0,1,2].map(i=>({ t:NOW-(21-i*10)*D, day:['2026-08-24','2026-09-03','2026-09-13'][i], f:'r'+i,
  d: pool.reduce((m,d)=>{
       const declining = d.did === '12015559999';       // the carrier-flagged one
       m[canonPh(d.did)] = [d.calls, declining ? Math.max(1, d.cr+(2-i)*7) : d.cr, d.dncCount];
       return m;
     },{}) }));

const ctx  = buildCtx(pool, repBy, snaps);
const rows = pool.map(d=>({...d, diag: classify(d, ctx)}));

_e('\n=== RENDER: all four views, populated ===');
render('CommandCenter',  React.createElement(CommandCenter,  {rows, snaps, repBy}));
render('TrendsView',     React.createElement(TrendsView,     {rows, snaps, onBackfill(){}}));
render('ReputationView', React.createElement(ReputationView, {rows, repBy, onImport(){}, onClear(){}}));
render('BuyListView',    React.createElement(BuyListView,    {rows, ctx}));
render('RepImport',      React.createElement(RepImport,      {onClose(){}, onDone(){}}));
render('TrendChart',     React.createElement(TrendChart, {label:'Pool contact rate',
  series: poolTrend(snaps).map(p=>({t:p.t,day:p.day,v:p.avgCr})), fmt:v=>v.toFixed(1)+'%'}));

_e('\n=== RENDER: empty / first-run states ===');
const ectx=buildCtx([],{},[]);
render('CommandCenter (no data)',  React.createElement(CommandCenter,  {rows:[], snaps:[], repBy:{}}));
render('TrendsView (no history)',  React.createElement(TrendsView,     {rows:[], snaps:[], onBackfill(){}}));
render('TrendsView (1 snapshot)',  React.createElement(TrendsView,     {rows, snaps:[snaps[0]], onBackfill(){}}));
render('BackfillImport',           React.createElement(BackfillImport,  {onClose(){}, onDone(){}}));
render('ReputationView (no scans)',React.createElement(ReputationView, {rows:pool.map(d=>({...d,diag:classify(d,buildCtx(pool,{},[]))})), repBy:{}, onImport(){}, onClear(){}}));
render('BuyListView (empty pool)', React.createElement(BuyListView,    {rows:[], ctx:ectx}));

_e('\n=== CONTENT ASSERTIONS ===');
const cc = renderToStaticMarkup(React.createElement(CommandCenter,{rows,snaps,repBy}));
const chk=(c,m)=>{ if(c){pass++;_e('  PASS  '+m);} else {fail++;_e('  FAIL  '+m);} };
chk(/need action|needs action/.test(cc), 'command center states how many numbers need action');
chk(cc.includes('Burned'),               'the carrier-flagged number surfaces as Burned');
chk(cc.includes('list problem') || cc.includes('Clean —'), 'the clean underperformer surfaces as a list problem');
const bl = renderToStaticMarkup(React.createElement(BuyListView,{rows,ctx}));
chk(/Buy \d+ number/.test(bl),           'buy list gives a concrete purchase count');
const rv = renderToStaticMarkup(React.createElement(ReputationView,{rows,repBy,onImport(){},onClear(){}}));
chk(rv.includes('AT&amp;T')||rv.includes('AT&T'), 'reputation view names the flagging carriers');
chk(rv.includes('Convoso Ignite') && rv.includes('CallPurity') && rv.includes('DNC.com') && rv.includes('Caller ID Reputation'),
    'all four named tools appear as import sources');

const real = warnings.filter(w=>!/useLayoutEffect|not wrapped in act/.test(w));
_e('\n=== REACT WARNINGS: ' + (real.length? real.length+' ===' : 'none ===') );
real.slice(0,6).forEach(w=>_e('  WARN  '+w.slice(0,200)));
if(real.length) fail+=real.length;
_e(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);
process.exit(fail?1:0);
