// Full-page integration: load analytics.js then app.js into ONE shared script
// scope, exactly as index.html does, and render the real App component.
const fs = require('fs'); const vm = require('vm');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');

const _ls = new Map();
const warnings = [];
function makeSandbox(){ return {
  React, ReactDOM: { createRoot: () => ({ render: () => {} }) },
  Papa: require(__dirname + '/vendor/papaparse.js'),
  console: { log(){}, warn:(...a)=>warnings.push(a.join(' ')), error:(...a)=>warnings.push(a.join(' ')) },
  window: { localStorage: { getItem:k=>_ls.has(k)?_ls.get(k):null,
            setItem:(k,v)=>_ls.set(k,String(v)), removeItem:k=>_ls.delete(k) } },
  document: { getElementById: () => ({}), createElement: () => ({ click(){}, style:{} }),
              body: { appendChild(){}, removeChild(){} } },
  setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, isNaN,
  parseInt, parseFloat, Set, Map, Infinity, encodeURIComponent,
}; }
const base = __dirname + '/../';
let sandbox, ctx;
function freshPage(){                      // == one browser page load
  sandbox = makeSandbox();
  sandbox.globalThis = sandbox; sandbox.window.document = sandbox.document;
  ctx = vm.createContext(sandbox);
}
const load = f => {
  try { vm.runInContext(fs.readFileSync(base+f,'utf8'), ctx, { filename:f }); 
        console.log('  PASS  '+f+' evaluated with no error'); return true; }
  catch(e){ console.log('  FAIL  '+f+' -> '+e.constructor.name+': '+e.message); return false; }
};
freshPage();

console.log('=== SCRIPT LOAD ORDER (as index.html) ===');
let ok = true;
ok = load('data.js')      && ok;
ok = load('analytics.js') && ok;
ok = load('app.js')       && ok;     // a collision or TDZ error would explode HERE
if (!ok) { console.log('\n  Aborting: scripts failed to evaluate.'); process.exit(1); }

console.log('\n=== RENDER THE REAL APP ===');
let fails = 0;
function tryRender(label){
  try {
    const html = renderToStaticMarkup(React.createElement(sandbox.App));
    console.log(`  PASS  ${label} (${html.length} chars)`);
    return html;
  } catch(e){ fails++; console.log(`  FAIL  ${label} -> ${e.message}`); return ''; }
}
// 1. Cold start: empty localStorage, first-ever load.
let html = tryRender('cold start, no saved pool');

// 2. With a saved pool, snapshots and reputation already in storage.
const mk=(did,cr,calls,dnc)=>({id:1,did:did,calls,answered:Math.round(calls*cr/100),cr,dncCount:dnc||0,
  campaign:'Southern Tier 2',notes:'',swapped:false});
const pool=[]; for(let i=0;i<10;i++) pool.push(mk('1201555'+(1000+i),19+(i%5),300+i*20,i%4===0?1:0));
pool.push(mk('12015559999',5,600,7));
_ls.set('did_monitor_pool_v1', JSON.stringify({dids:pool, importedAt:{fname:'convoso.csv',time:Date.now()}}));
const D=86400000, NOW=Date.now();
_ls.set('did_monitor_snapshots_v1', JSON.stringify({v:1, snaps:[0,1].map(i=>({
  t:NOW-(14-i*14)*D, day:i?'2026-09-13':'2026-08-30', f:'r'+i,
  d: pool.reduce((m,d)=>(m[d.did.slice(1)]=[d.calls, d.cr+(1-i)*6, d.dncCount],m),{}) }))}));
_ls.set('did_monitor_reputation_v1', JSON.stringify({v:1, byPhone:{
  '2015559999': { vendors:{ calleridrep:{ at:NOW, flagged:true, score:11, label:'Scam Likely',
                             carriers:{att:'flagged',tmobile:'flagged'} } } } }}));
// Reload the page so the stores re-read the now-populated localStorage.
console.log('\n  -- reloading page with data in storage --');
freshPage();
if(!(load('data.js') && load('analytics.js') && load('app.js'))) process.exit(1);
html = tryRender('with saved pool + snapshots + reputation');

const chk=(c,m)=>{ if(c) console.log('  PASS  '+m); else { fails++; console.log('  FAIL  '+m); } };
console.log('\n=== ASSERTIONS: POOL VIEW ===');
// Read the version from source rather than hardcoding it, so a release bump
// does not fail the suite. What matters is that the banner MATCHES the source.
const srcVer = (fs.readFileSync(base+'app.js','utf8').match(/v6\.\d+\.\d+/) || [])[0];
chk(!!srcVer && html.includes(srcVer), `version banner matches app.js (${srcVer})`);
const htmlVer = (fs.readFileSync(base+'index.html','utf8').match(/analytics\.js\?v=(\d+)/) || [])[1];
const cssVer  = (fs.readFileSync(base+'index.html','utf8').match(/analytics\.css\?v=(\d+)/) || [])[1];
chk(htmlVer && htmlVer === cssVer, `cache-buster consistent across assets (v=${htmlVer})`);
chk(html.includes('DNC Alert'), 'existing pool tabs untouched');

// Drive the app onto the Analytics view, and onto each sub-tab in turn, by
// seeding the initial state — the only way to reach them without a browser.
function renderOn(tab){
  freshPage();
  const src = fs.readFileSync(base+'app.js','utf8')
    .replace("useState('pool')", "useState('intel')")
    .replace("useState('command')", `useState('${tab}')`);
  vm.runInContext(fs.readFileSync(base+'data.js','utf8'), ctx, {filename:'data.js'});
  vm.runInContext(fs.readFileSync(base+'analytics.js','utf8'), ctx, {filename:'analytics.js'});
  vm.runInContext(src, ctx, {filename:'app.js'});
  try { return renderToStaticMarkup(React.createElement(sandbox.App)); }
  catch(e){ fails++; console.log(`  FAIL  render sub-tab "${tab}" -> ${e.message}`); return ''; }
}

console.log('\n=== ANALYTICS VIEW: EVERY SUB-TAB RENDERS ===');
const tabHtml = {};
for (const t of ['command','trends','rep','buy','area','burn','curve','camp','pivot']) {
  const hh = renderOn(t);
  tabHtml[t] = hh;
  chk(hh.length > 20000, `sub-tab "${t}" renders (${hh.length} chars)`);
}

console.log('\n=== ANALYTICS VIEW: CONTENT ===');
const nav = tabHtml.command;
['Command','Trends','Reputation','Buy list','Area codes','Campaign load']
  .forEach(t => chk(nav.includes(t), `sub-tab button present: ${t}`));
chk(/need action|needs action|Nothing needs replacing/.test(tabHtml.command),
    'Command states the headline in plain language');
chk(/Burned|Flagged but still working/.test(tabHtml.command), 'Command surfaces the flagged number');
chk(tabHtml.trends.includes('Pool contact rate'),  'Trends charts pool contact rate');
chk(/Biggest movers/.test(tabHtml.trends),          'Trends lists biggest movers');
chk(tabHtml.rep.includes('Convoso Ignite') && tabHtml.rep.includes('CallPurity')
    && tabHtml.rep.includes('DNC.com') && tabHtml.rep.includes('Caller ID Reputation'),
    'Reputation names all four tools');
chk(/Scam Likely|Flagged numbers/.test(tabHtml.rep), 'Reputation lists the flagged number');
chk(/Target calls per working number/.test(tabHtml.buy), 'Buy list exposes the target control');
chk(tabHtml.area.includes('Area-code health'),      'original Area-code board still intact');
chk(/Back-fill from saved reports/.test(tabHtml.trends), 'Trends offers the back-fill lane');

console.log('\n=== BACK-FILL PARSES A REAL CONVOSO REPORT (needs app.js autoDetect) ===');
const conv = 'Campaign,DID,Calls,Contacts,Contacts %,DNC\n'
           + 'Southern Tier 2,12015551111,300,60,20.0,1\n'
           + 'Southern Tier 2,12015552222,400,40,10.0,5\n';
try {
  const pc = sandbox.parseConvosoReport(conv);
  chk(pc.rows.length === 2, 'Convoso report parsed through app.js autoDetect');
  chk(JSON.stringify(pc.rows[0]) === JSON.stringify({did:'2015551111',calls:300,cr:20,dncCount:1}),
      'row canonicalised to snapshot shape (10-digit key, % stripped)');
  const bad = sandbox.parseConvosoReport('Foo,Bar\n1,2\n');
  chk(bad.rows.length === 0, 'a file with no DID/Calls columns yields nothing rather than garbage');
} catch(e){ fails++; console.log('  FAIL  parseConvosoReport -> '+e.message); }

const real = warnings.filter(w=>!/useLayoutEffect|not wrapped in act/.test(w));
console.log('\n=== WARNINGS: ' + (real.length ? real.length : 'none') + ' ===');
real.slice(0,8).forEach(w=>console.log('  WARN  '+w.slice(0,220)));
fails += real.length;
console.log(`\n${'='.repeat(52)}\n  integration: ${fails ? fails+' FAILED' : 'ALL PASS'}\n${'='.repeat(52)}`);
process.exit(fails?1:0);
