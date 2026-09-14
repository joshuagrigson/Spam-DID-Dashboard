// ── DID Monitor — OCR Call Center
// app.js — React application (depends on data.js, React 18, PapaParse)

const { useState, useMemo, useRef, useEffect } = React;

// Safe localStorage wrapper — persists on the live site; degrades gracefully
// (no-op) in sandboxed preview environments where storage is blocked.
// Entry shape: { phone: { status: 'sent'|'replaced', sentAt, replacedAt?, campaign } }
const SENT_KEY = 'did_monitor_sent_v1';
const REPLACED_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const sentStore = {
  load() {
    let obj;
    try { obj = JSON.parse(window.localStorage.getItem(SENT_KEY)) || {}; }
    catch (e) { return {}; }
    // Migrate legacy entries (no status) to 'sent', and auto-purge replaced
    // numbers older than 60 days from when they were marked replaced.
    const now = Date.now();
    const cleaned = {};
    for (const [phone, m] of Object.entries(obj)) {
      const entry = (m && typeof m === 'object') ? m : {};
      const status = entry.status || 'sent';
      if (status === 'replaced' && entry.replacedAt && (now - entry.replacedAt) > REPLACED_TTL_MS) continue; // expired
      cleaned[phone] = { status, sentAt: entry.sentAt || now, campaign: entry.campaign || '', resendCount: entry.resendCount || 0, ...(entry.replacedAt ? { replacedAt: entry.replacedAt } : {}) };
    }
    return cleaned;
  },
  save(obj) {
    try { window.localStorage.setItem(SENT_KEY, JSON.stringify(obj)); }
    catch (e) { /* storage unavailable — keep in memory only */ }
  },
};

// Pool persistence — the imported DID dataset survives refreshes/sessions.
// Shape: { dids: [...], importedAt: { fname, time } | null }
const POOL_KEY = 'did_monitor_pool_v1';
const poolStore = {
  load() {
    try {
      const obj = JSON.parse(window.localStorage.getItem(POOL_KEY));
      if (!obj || !Array.isArray(obj.dids) || obj.dids.length === 0) return null;
      return obj;
    } catch (e) { return null; }
  },
  save(dids, importedAt) {
    try { window.localStorage.setItem(POOL_KEY, JSON.stringify({ dids, importedAt })); }
    catch (e) { /* storage unavailable — keep in memory only */ }
  },
  clear() {
    try { window.localStorage.removeItem(POOL_KEY); } catch (e) { /* no-op */ }
  },
};
const SAVED_POOL = poolStore.load();

// ── First-seen ledger — the seed for real DID lifespan measurement ────────────
// Every DID gets an immutable first-observation timestamp the first time it
// shows up in any import. Nothing ever overwrites it. Ages are therefore
// measured from when THIS dashboard first saw a number, not from when it was
// bought -- the Intel view states that plainly and reports how mature the
// tracking window is rather than passing young data off as a lifespan.
const FIRSTSEEN_KEY = 'did_monitor_firstseen_v1';
const firstSeenStore = {
  load() {
    try { return JSON.parse(window.localStorage.getItem(FIRSTSEEN_KEY)) || {}; }
    catch (e) { return {}; }
  },
  save(obj) {
    try { window.localStorage.setItem(FIRSTSEEN_KEY, JSON.stringify(obj)); }
    catch (e) { /* storage unavailable -- keep in memory only */ }
  },
  // Stamp every unseen phone with `now`; existing stamps are left alone.
  // Returns the updated map, or the same object when nothing was added.
  stamp(phones) {
    const map = firstSeenStore.load();
    const now = Date.now();
    let added = 0;
    for (const p of phones) {
      const k = String(p).replace(/\D/g, '');
      if (k && !map[k]) { map[k] = now; added++; }
    }
    if (added) { firstSeenStore.save(map); return { map, added }; }
    return { map, added: 0 };
  },
};

// When intelligence tracking began on this browser. Written once, then read
// forever, so the Intel view can say how many days of history back a number.
const TRACKSTART_KEY = 'did_monitor_trackstart_v1';
const TRACK_START = (() => {
  try {
    let t = window.localStorage.getItem(TRACKSTART_KEY);
    if (!t) { t = String(Date.now()); window.localStorage.setItem(TRACKSTART_KEY, t); }
    return parseInt(t, 10) || Date.now();
  } catch (e) { return Date.now(); }
})();

const DAY_MS = 86400000;

// Canadian provinces and territories. NANPA covers Canada, so a US-lead pool
// picks these up whenever a Canadian area code is in play.
const CA_PROVINCES = new Set(['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']);

// ── Pivot dimensions & metrics ───────────────────────────────────────────────
// The fixed tabs each answer one question. This answers the ones not thought of
// yet — and it matters most on a single-campaign export, where the center split
// stops being the interesting axis and area code, volume band or grade take over.
function volBand(calls) {
  const c = calls || 0;
  if (c < 25)  return '1 · under 25 (low data)';
  if (c < 50)  return '2 · 25-50';
  if (c < 100) return '3 · 50-100';
  if (c < 200) return '4 · 100-200';
  if (c < 350) return '5 · 200-350';
  if (c < 500) return '6 · 350-500';
  return '7 · 500+';
}
const PIVOT_DIMS = [
  { k: 'area',     l: 'Area code', plural: 'area codes', get: d => d.area,
    lab: v => v + (NPA_GEO[v] ? ' · ' + NPA_GEO[v][0] + ', ' + NPA_GEO[v][1] : '') },
  // Not "State": the pool carries Canadian provinces and DC alongside US states,
  // so labelling the axis "State" and totalling "all 59 states" is simply wrong.
  // Canadian rows are marked and held out of the total — they are real numbers
  // being dialled, but they do not belong in a figure describing the US operation.
  { k: 'state',    l: 'State / province', plural: 'US states & DC',
    get: d => (NPA_GEO[d.area] ? NPA_GEO[d.area][1] : '—'),
    lab: v => CA_PROVINCES.has(v) ? v + ' *' : (v === '—' ? 'Unmapped' : v),
    outOfTotal: v => CA_PROVINCES.has(v) },
  { k: 'campaign', l: 'Campaign',    plural: 'campaigns',    get: d => d.campaign || 'Unassigned' },
  { k: 'center',   l: 'Call center', plural: 'call centers', get: d => d.center },
  { k: 'band',     l: 'Call volume', plural: 'volume bands', get: d => volBand(d.calls), ord: true },
  { k: 'grade',    l: 'Grade',       plural: 'grades',       get: d => d.grade || 'Low data', ord: true },
];
const PIVOT_METRICS = [
  { k: 'cr',     l: 'Contact rate', short: 'CR',      fmt: v => v.toFixed(1) + '%',
    agg: a => a.calls ? (a.ans / a.calls) * 100 : null, betterLow: false },
  { k: 'dids',   l: 'Numbers',      short: 'DIDs',    fmt: v => v.toLocaleString(),
    agg: a => a.dids, betterLow: false },
  { k: 'calls',  l: 'Calls',        short: 'Calls',   fmt: v => v.toLocaleString(),
    agg: a => a.calls, betterLow: false },
  { k: 'perDid', l: 'Calls / number', short: 'C/DID', fmt: v => v.toFixed(1),
    agg: a => a.dids ? a.calls / a.dids : null, betterLow: true },
  { k: 'dnc1k',  l: 'DNC per 1k',   short: 'DNC/1k',  fmt: v => v.toFixed(2),
    agg: a => a.calls ? (a.dnc / a.calls) * 1000 : null, betterLow: true },
  { k: 'atRisk', l: 'At risk %',    short: 'Risk',    fmt: v => v.toFixed(1) + '%',
    agg: a => a.scorable ? (a.risky / a.scorable) * 100 : null, betterLow: true },
  { k: 'score',  l: 'Avg score',    short: 'Score',   fmt: v => v.toFixed(0),
    agg: a => a.scorable ? a.scoreSum / a.scorable : null, betterLow: false },
];
function pivotCell() { return { dids: 0, calls: 0, ans: 0, dnc: 0, scorable: 0, risky: 0, scoreSum: 0 }; }
function pivotAdd(c, d) {
  c.dids++; c.calls += d.calls || 0; c.ans += d.answered || 0; c.dnc += d.dncCount || 0;
  if (d.score !== null) { c.scorable++; c.scoreSum += d.score; if (d.grade === 'D' || d.grade === 'F') c.risky++; }
}

// ── Call centers ─────────────────────────────────────────────────────────────
// Northern and Southern tiers are run by two different call centers with two
// different DID pools. Any figure averaged across both describes neither, so
// the dashboard scopes to one at a time. Campaign naming is the only signal
// available in the Convoso export, and it is consistent: "Northern Tier N" /
// "Southern Tier N". Anything else is parked in Other rather than guessed at.
function centerOf(campaign) {
  const c = String(campaign || '').trim().toLowerCase();
  if (c.startsWith('north')) return 'North';
  if (c.startsWith('south')) return 'South';
  return 'Other';
}
const CENTER_LB = { South: 'Southern', North: 'Northern', Other: 'Unassigned' };
// Both centers use this dashboard, so it cannot assume whose it is. Each
// browser records which center that person works; it sets their default scope
// and decides which center the copy calls "yours". Until answered the scope
// stays on 'all' — showing someone a filtered pool before they have said who
// they are would quietly hide half their numbers.
const HOME_KEY  = 'did_monitor_home_center_v1';
const SCOPE_KEY = 'did_monitor_scope_v1';
const SAVED_HOME = (() => {
  try {
    const v = window.localStorage.getItem(HOME_KEY);
    return (v === 'South' || v === 'North' || v === 'all') ? v : null;
  } catch (e) { return null; }
})();
const SAVED_SCOPE = (() => {
  try { return window.localStorage.getItem(SCOPE_KEY) || SAVED_HOME || 'all'; }
  catch (e) { return SAVED_HOME || 'all'; }
})();

// ── Area-code geography (NANPA centroids) ────────────────────────────────────
// Local presence means an area code is chosen to match the lead being dialled,
// so a burned area code cannot simply be abandoned -- it can only be swapped
// for another that reaches the SAME PEOPLE. That makes distance the deciding
// factor, not health alone. Coordinates are the centroid of the cities NANPA
// lists for each code, which puts same-city overlays (Houston 713/281/832/346,
// Detroit 313/248/734/586) at effectively zero distance from one another.
const NPA_GEO = {"201":["Hackensack","NJ",40.84,-74.05],"202":["Washington","DC",38.9,-77.04],"203":["Shelton","CT",41.29,-73.12],"204":["Portage la Prairie","MB",51.2,-98.73],"205":["Bessemer","AL",33.43,-86.89],"206":["Seattle","WA",47.56,-122.35],"207":["Brunswick","ME",44.0,-69.99],"208":["Boise","ID",44.42,-115.56],"209":["West Modesto","CA",37.6,-121.0],"210":["San Antonio","TX",29.42,-98.49],"212":["New York City","NY",40.71,-74.01],"213":["Los Angeles","CA",34.05,-118.24],"214":["University Park","TX",32.86,-96.84],"215":["Philadelphia","PA",40.05,-75.0],"216":["Garfield Heights","OH",41.48,-81.62],"217":["Decatur","IL",39.92,-88.89],"218":["Andover","MN",46.3,-94.06],"219":["Hobart","IN",41.57,-87.26],"220":["Lancaster","OH",39.75,-82.66],"224":["Buffalo Grove","IL",42.15,-87.95],"225":["Baton Rouge","LA",30.45,-91.16],"226":["London","ON",43.23,-81.23],"228":["Biloxi","MS",30.39,-88.84],"229":["Albany","GA",31.21,-83.72],"231":["Muskegon","MI",43.02,-85.18],"234":["Kent","OH",41.06,-81.31],"236":["Kamloops","BC",50.43,-121.52],"239":["Bonita Springs","FL",26.46,-81.8],"240":["North Bethesda","MD",39.05,-77.12],"248":["Southfield","MI",42.54,-83.26],"249":["North Bay","ON",46.04,-80.0],"250":["Merritt","BC",50.84,-121.84],"251":["Mobile","AL",30.72,-88.06],"252":["Greenville","NC",35.42,-77.43],"253":["Tacoma","WA",47.23,-122.37],"254":["Killeen","TX",31.2,-97.58],"256":["Madison","AL",34.42,-86.64],"260":["Fort Wayne","IN",41.13,-85.13],"262":["New Berlin","WI",42.99,-88.04],"267":["Philadelphia","PA",40.05,-75.0],"269":["Kalamazoo","MI",42.27,-85.45],"270":["Owensboro","KY",37.44,-87.01],"272":["Back Mountain","PA",41.24,-76.1],"276":["Richmond","VA",37.55,-77.46],"281":["South Houston","TX",29.71,-95.3],"289":["Markham","ON",43.56,-79.33],"301":["North Bethesda","MD",39.05,-77.12],"302":["Newark","DE",39.53,-75.61],"303":["Denver","CO",39.78,-105.0],"304":["Parkersburg","WV",39.36,-81.16],"305":["Westchester","FL",25.74,-80.36],"306":["Moose Jaw","SK",51.4,-105.69],"307":["Casper","WY",42.4,-105.56],"308":["Kearney","NE",40.92,-99.4],"309":["Peoria","IL",40.93,-89.86],"310":["Lawndale","CA",33.9,-118.35],"312":["West Chicago","IL",41.88,-88.2],"313":["Dearborn","MI",42.31,-83.2],"314":["University City","MO",38.65,-90.32],"315":["Syracuse","NY",43.25,-75.86],"316":["Wichita","KS",37.69,-97.34],"317":["Lawrence","IN",39.87,-86.07],"318":["Ruston","LA",32.28,-92.94],"319":["Cedar Rapids","IA",41.92,-91.78],"320":["Saint Cloud","MN",45.56,-94.16],"321":["Saint Cloud","FL",28.38,-81.15],"323":["Huntington Park","CA",33.99,-118.21],"325":["San Angelo","TX",31.96,-100.08],"330":["Kent","OH",41.06,-81.31],"331":["Wheaton","IL",41.88,-88.09],"334":["Montgomery","AL",32.19,-85.86],"336":["Greensboro","NC",35.99,-79.86],"337":["Lafayette","LA",30.24,-92.5],"339":["Medford","MA",42.39,-71.1],"343":["Smiths Falls","ON",44.95,-76.09],"346":["South Houston","TX",29.71,-95.3],"347":["Brooklyn","NY",40.69,-73.96],"351":["Wilmington","MA",42.6,-71.23],"352":["Spring Hill","FL",28.37,-81.78],"360":["Bremerton","WA",47.41,-122.57],"361":["Corpus Christi","TX",28.04,-97.42],"364":["Owensboro","KY",37.44,-87.01],"365":["Hamilton","ON",43.58,-79.35],"385":["Murray","UT",40.65,-111.88],"386":["Daytona Beach","FL",29.17,-81.11],"401":["Cranston","RI",41.77,-71.42],"402":["Fremont","NE",41.24,-96.88],"403":["Strathmore","AB",51.21,-113.59],"404":["Atlanta","GA",33.73,-84.37],"405":["Midwest City","OK",35.5,-97.41],"406":["Helena","MT",46.41,-111.57],"407":["Oak Ridge","FL",28.39,-81.31],"408":["Campbell","CA",37.27,-121.89],"409":["Galveston","TX",29.66,-94.44],"410":["Baltimore","MD",39.25,-76.59],"412":["West Mifflin","PA",40.4,-79.92],"413":["Westfield","MA",42.2,-72.71],"414":["Greenfield","WI",42.95,-87.95],"415":["San Rafael","CA",37.93,-122.52],"416":["Toronto","ON",43.46,-79.7],"417":["Joplin","MO",37.15,-93.91],"419":["Findlay","OH",41.13,-83.22],"423":["Morristown","TN",35.84,-83.68],"424":["Lawndale","CA",33.9,-118.35],"425":["Cottage Lake","WA",47.73,-121.86],"431":["Portage la Prairie","MB",51.2,-98.73],"432":["Midland","TX",32.03,-102.02],"434":["West Lynchburg","VA",37.34,-79.02],"435":["Tooele","UT",39.27,-112.69],"437":["Toronto","ON",43.7,-79.42],"440":["Parma","OH",41.48,-81.7],"442":["Palm Springs","CA",33.67,-116.76],"443":["Baltimore","MD",39.25,-76.59],"458":["Springfield","OR",43.77,-123.19],"469":["University Park","TX",32.87,-96.83],"478":["Warner Robins","GA",32.73,-83.62],"479":["Fayetteville","AR",35.85,-93.99],"480":["Mesa","AZ",33.43,-111.79],"484":["Norristown","PA",40.25,-75.46],"501":["North Little Rock","AR",34.77,-92.42],"502":["Frankfort","KY",38.23,-85.32],"503":["Tualatin","OR",45.35,-122.8],"504":["New Orleans","LA",29.94,-90.09],"505":["Rio Rancho","NM",35.55,-107.15],"506":["Miramichi","NB",46.57,-66.06],"507":["Owatonna","MN",44.05,-92.94],"508":["Attleboro","MA",42.01,-71.22],"509":["Pasco","WA",46.77,-118.73],"510":["Fremont","CA",37.43,-121.81],"512":["Austin","TX",30.36,-97.77],"513":["Fairfield","OH",39.35,-84.5],"515":["Ankeny","IA",41.84,-93.75],"516":["Uniondale","NY",40.7,-73.6],"517":["Jackson","MI",42.49,-84.14],"518":["Schenectady","NY",42.82,-73.83],"519":["Dorchester","ON",43.21,-81.14],"520":["Drexel Heights","AZ",32.12,-110.98],"530":["Yuba City","CA",39.34,-121.57],"531":["Fremont","NE",41.24,-96.88],"539":["Broken Arrow","OK",36.17,-95.78],"540":["Staunton","VA",37.83,-79.5],"541":["Springfield","OR",43.77,-123.19],"551":["Hackensack","NJ",40.84,-74.05],"559":["Reedley","CA",36.51,-119.54],"561":["Boynton Beach","FL",26.56,-80.14],"562":["Norwalk","CA",33.9,-118.08],"563":["Davenport","IA",41.76,-90.6],"567":["Findlay","OH",41.13,-83.22],"570":["Back Mountain","PA",41.24,-76.1],"571":["Fairfax","VA",38.83,-77.27],"573":["Jefferson City","MO",38.28,-91.34],"574":["Elkhart","IN",41.67,-86.07],"575":["Roswell","NM",33.02,-104.64],"580":["Duncan","OK",35.17,-97.97],"585":["Rochester","NY",43.17,-77.58],"586":["Roseville","MI",42.54,-82.97],"587":["Ponoka","AB",52.69,-113.7],"601":["Pearl","MS",32.2,-89.96],"602":["Phoenix","AZ",33.45,-112.07],"603":["Manchester","NH",43.05,-71.33],"604":["North Vancouver","BC",49.31,-122.98],"605":["Pierre","SD",44.47,-99.18],"606":["Ashland","KY",38.48,-82.64],"607":["Ithaca","NY",42.21,-76.41],"608":["Fitchburg","WI",43.04,-89.56],"609":["Willingboro","NJ",39.97,-74.71],"610":["Norristown","PA",40.25,-75.46],"612":["Saint Louis Park","MN",44.97,-93.32],"613":["Perth","ON",44.94,-76.4],"614":["Columbus","OH",40.01,-83.01],"615":["Smyrna","TN",36.11,-86.59],"616":["Wyoming","MI",42.92,-85.73],"617":["Brookline","MA",42.35,-71.1],"618":["O'Fallon","IL",38.57,-89.93],"619":["Lemon Grove","CA",32.72,-117.05],"620":["Hutchinson","KS",38.05,-98.75],"623":["Surprise","AZ",33.59,-112.3],"626":["Baldwin Park","CA",34.08,-118.0],"628":["San Rafael","CA",37.93,-122.52],"629":["Smyrna","TN",36.11,-86.59],"630":["Wheaton","IL",41.88,-88.09],"631":["Central Islip","NY",40.79,-73.21],"636":["Chesterfield","MO",38.71,-90.6],"639":["Saskatoon","SK",51.64,-106.0],"641":["Marshalltown","IA",42.07,-92.84],"646":["New York City","NY",40.71,-74.01],"647":["Toronto","ON",43.7,-79.42],"650":["Belmont","CA",37.53,-122.28],"651":["Saint Paul","MN",44.91,-93.08],"657":["Anaheim","CA",33.8,-117.92],"660":["Sedalia","MO",38.7,-93.23],"661":["Bakersfield","CA",35.12,-118.78],"662":["Olive Branch","MS",34.11,-89.63],"667":["Baltimore","MD",39.25,-76.59],"669":["Campbell","CA",37.27,-121.89],"678":["Atlanta","GA",33.81,-84.36],"681":["Parkersburg","WV",39.36,-81.16],"682":["Haltom City","TX",32.76,-97.22],"701":["Bismarck","ND",47.46,-99.0],"702":["Winchester","NV",36.14,-115.11],"703":["Fairfax","VA",38.83,-77.27],"704":["Huntersville","NC",35.37,-80.75],"705":["Parry Sound","ON",45.72,-80.31],"706":["Athens","GA",33.64,-83.94],"707":["Santa Rosa","CA",38.51,-122.53],"708":["Evergreen Park","IL",41.71,-87.73],"709":["Grand Falls-Windsor","NL",48.95,-55.96],"712":["Sioux City","IA",41.88,-96.13],"713":["South Houston","TX",29.71,-95.3],"714":["Anaheim","CA",33.8,-117.92],"715":["Eau Claire","WI",45.25,-90.7],"716":["Buffalo","NY",42.88,-78.89],"717":["York","PA",40.15,-76.58],"718":["Brooklyn","NY",40.69,-73.96],"719":["Security-Widefield","CO",38.64,-104.75],"720":["Denver","CO",39.78,-105.0],"724":["Upper Saint Clair","PA",40.56,-79.99],"725":["Winchester","NV",36.14,-115.11],"727":["Dunedin","FL",28.01,-82.74],"731":["Jackson","TN",35.62,-88.81],"732":["South Old Bridge","NJ",40.42,-74.32],"734":["Romulus","MI",42.25,-83.41],"737":["Austin","TX",30.36,-97.77],"740":["Lancaster","OH",39.75,-82.66],"743":["Greensboro","NC",35.99,-79.86],"747":["San Fernando","CA",34.19,-118.44],"754":["Lauderhill","FL",26.14,-80.2],"757":["Norfolk","VA",36.87,-76.31],"760":["Palm Springs","CA",33.67,-116.76],"762":["Athens","GA",33.64,-83.94],"763":["Brooklyn Park","MN",45.1,-93.36],"765":["Kokomo","IN",40.29,-85.94],"769":["Pearl","MS",32.2,-89.96],"770":["Atlanta","GA",33.83,-84.36],"772":["Fort Pierce South","FL",27.37,-80.35],"773":["West Chicago","IL",41.88,-88.2],"774":["Attleboro","MA",42.01,-71.22],"775":["Carson City","NV",38.61,-118.83],"778":["Whistler","BC",50.34,-122.22],"779":["DeKalb","IL",42.05,-88.62],"780":["Westlock","AB",53.93,-113.87],"781":["Medford","MA",42.39,-71.1],"782":["Halifax","NS",45.07,-63.87],"785":["Manhattan","KS",38.98,-96.89],"786":["Westchester","FL",25.74,-80.36],"801":["Murray","UT",40.65,-111.88],"802":["South Burlington","VT",44.36,-72.87],"803":["Saint Andrews","SC",34.09,-81.06],"804":["Richmond","VA",37.46,-77.42],"805":["Santa Barbara","CA",34.6,-119.7],"806":["Plainview","TX",34.33,-101.8],"807":["Thunder Bay","ON",47.5,-88.85],"808":["Honolulu","HI",20.96,-157.24],"810":["Burton","MI",42.99,-83.24],"812":["Bloomington","IN",38.67,-86.39],"813":["Temple Terrace","FL",28.05,-82.43],"814":["Altoona","PA",40.94,-78.81],"815":["DeKalb","IL",42.05,-88.62],"816":["Kansas City","MO",39.1,-94.5],"817":["Haltom City","TX",32.76,-97.22],"818":["San Fernando","CA",34.19,-118.44],"825":["Edmonton","AB",53.55,-113.32],"828":["Asheville","NC",35.67,-81.95],"830":["Kerrville","TX",29.48,-99.33],"831":["Marina","CA",36.76,-121.77],"832":["South Houston","TX",29.71,-95.3],"843":["Goose Creek","SC",33.09,-79.9],"845":["Newburgh","NY",41.47,-74.06],"847":["Buffalo Grove","IL",42.15,-87.95],"848":["South Old Bridge","NJ",40.42,-74.32],"850":["Fort Walton Beach","FL",30.42,-86.61],"854":["Goose Creek","SC",33.09,-79.9],"856":["Cherry Hill","NJ",39.74,-75.05],"857":["Brookline","MA",42.35,-71.1],"858":["Poway","CA",32.96,-117.04],"859":["Lexington","KY",38.45,-84.48],"860":["Wethersfield","CT",41.67,-72.64],"862":["Montclair","NJ",40.83,-74.22],"863":["Lakeland","FL",28.03,-81.84],"864":["Greenville","SC",34.72,-82.3],"865":["Oak Ridge","TN",35.93,-84.11],"870":["Pine Bluff","AR",34.65,-91.68],"878":["Pittsburgh","PA",40.46,-79.96],"901":["Germantown","TN",35.12,-89.85],"902":["Truro","NS",45.44,-63.16],"903":["Greenville","TX",33.01,-95.53],"904":["Jacksonville","FL",30.25,-81.61],"905":["Markham","ON",43.56,-79.33],"907":["Sitka","AK",60.27,-141.14],"908":["Cranford","NJ",40.66,-74.29],"909":["Rancho Cucamonga","CA",34.07,-117.54],"910":["Fayetteville","NC",34.76,-78.45],"912":["Hinesville","GA",32.13,-81.49],"913":["Shawnee","KS",39.03,-94.72],"914":["White Plains","NY",41.03,-73.81],"915":["Socorro","TX",31.71,-106.39],"916":["Rosemont","CA",38.54,-121.4],"917":["New York City","NY",40.7,-73.97],"918":["Broken Arrow","OK",36.17,-95.78],"919":["Cary","NC",35.73,-78.78],"920":["North Fond du Lac","WI",43.95,-88.28],"925":["Danville","CA",37.89,-121.94],"928":["Lake Havasu City","AZ",34.32,-113.55],"929":["Brooklyn","NY",40.69,-73.96],"930":["Bloomington","IN",38.67,-86.39],"931":["Columbia","TN",36.1,-86.63],"936":["Lufkin","TX",30.99,-95.1],"937":["Huber Heights","OH",39.85,-84.12],"940":["Denton","TX",33.39,-97.54],"941":["North Port","FL",27.2,-82.34],"947":["Southfield","MI",42.54,-83.26],"949":["Aliso Viejo","CA",33.57,-117.73],"951":["Perris","CA",33.82,-117.26],"952":["Eden Prairie","MN",44.84,-93.41],"954":["Lauderhill","FL",26.14,-80.2],"956":["Edinburg","TX",26.3,-98.14],"959":["Wethersfield","CT",41.67,-72.64],"970":["Loveland","CO",40.12,-105.86],"971":["Tualatin","OR",45.35,-122.8],"972":["University Park","TX",32.87,-96.83],"973":["Montclair","NJ",40.84,-74.22],"978":["Wilmington","MA",42.6,-71.23],"979":["College Station","TX",30.11,-96.05],"980":["Huntersville","NC",35.37,-80.75],"984":["Cary","NC",35.73,-78.78],"985":["Laplace","LA",29.98,-90.33],"989":["Midland","MI",43.53,-84.16]};
function npaLabel(code) {
  const g = NPA_GEO[code];
  return g ? g[0] + ', ' + g[1] : 'Unknown area';
}
function npaState(code) { const g = NPA_GEO[code]; return g ? g[1] : ''; }
// Great-circle miles between two area-code centroids; null if either is unmapped.
function npaMiles(a, b) {
  const A = NPA_GEO[a], B = NPA_GEO[b];
  if (!A || !B) return null;
  const R = 3958.8, rad = d => d * Math.PI / 180;
  const dLat = rad(B[2] - A[2]), dLon = rad(B[3] - A[3]);
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(rad(A[2])) * Math.cos(rad(B[2])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
// How far a substitute may sit before it stops being "local" to the lead.
const SAME_CITY_MI = 30;    // an overlay serving the same metro
const LOCAL_MI     = 150;   // still plausibly local; past this, presence is lost

// ── Area-code status ─────────────────────────────────────────────────────────
// NOT a buy/avoid verdict -- under local presence the area code is dictated by
// the lead, so the only real decisions are how hard to cycle numbers and
// whether a nearby overlay is healthier. The primary signal is the share of
// numbers that have fallen well below the OTHER numbers in their own area code,
// which is region-neutral by construction. Contact rate is deliberately NOT
// scored against the pool average -- only an absolute floor applies, because a
// region can simply answer less without any carrier having flagged anything.
const MIN_AC_DIDS   = 3;
const MIN_AC_CALLS  = 200;
const MIN_MEDIAN_N  = 6;    // numbers needed before an in-area median means anything
const DEGRADED_FRAC = 0.60; // below 60% of its own area code's median = damaged

function acStatus(a, base) {
  if (a.dids < MIN_AC_DIDS || a.calls < MIN_AC_CALLS) {
    return { key: 'low', lb: 'Low data', risk: null };
  }
  let risk = 0;

  // 1. Damaged share, measured inside the area code. Unavailable below
  //    MIN_MEDIAN_N numbers, in which case it contributes nothing rather than
  //    contributing noise.
  if (a.medianN >= MIN_MEDIAN_N) {
    if      (a.degradedPct >= 30) risk += 3;
    else if (a.degradedPct >= 18) risk += 2;
    else if (a.degradedPct >= 8)  risk += 1;
  }

  // 2. DNC pressure -- people actively asking to be removed. This is a reaction
  //    to your number rather than a property of the region, so it stays scored
  //    against the pool, with an absolute floor.
  const d1k      = a.calls ? (a.dnc / a.calls) * 1000 : 0;
  const poolD1k  = base && base.dnc1k > 0 ? base.dnc1k : 2;
  const dncRatio = d1k / poolD1k;
  let dncPts = 0;
  if      (dncRatio >= 3.0)  dncPts = 3;
  else if (dncRatio >= 2.0)  dncPts = 2;
  else if (dncRatio >= 1.35) dncPts = 1;
  if (d1k >= 15) dncPts = 3;
  else if (d1k >= 8) dncPts = Math.max(dncPts, 2);
  risk += dncPts;

  // 3. Grade mix -- calcScore is already pool-calibrated.
  const arp = a.scorable ? (a.atRisk / a.scorable) * 100 : 0;
  if      (arp >= 40) risk += 3;
  else if (arp >= 25) risk += 2;
  else if (arp >= 12) risk += 1;

  // 4. Track record: how much of what you have held here has already burned.
  const br = a.ever ? (a.burned / a.ever) * 100 : 0;
  if      (br >= 40) risk += 3;
  else if (br >= 25) risk += 2;
  else if (br >= 10) risk += 1;

  // 5. Absolute floor only -- never relative to the pool.
  const cr = a.calls ? (a.ans / a.calls) * 100 : 0;
  if (cr < 8) risk += 2;
  else if (cr < 12) risk += 1;

  if (risk >= 6) return { key: 'refresh', lb: 'Refresh now',  risk };
  if (risk >= 3) return { key: 'cycle',   lb: 'Cycle faster', risk };
  return          { key: 'ok',      lb: 'Healthy',      risk };
}
const STATUS_STYLE = {
  ok:      { bg: '#d4ecbf', tx: '#1e3f06', br: '#4f8210' },
  cycle:   { bg: '#f5dfa8', tx: '#3f2200', br: '#9a5e0a' },
  refresh: { bg: '#f5cece', tx: '#5c1010', br: '#cc2828' },
  low:     { bg: '#ececea', tx: '#6b6b66', br: '#cfcfc9' },
};

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

const h = React.createElement;

// ── Sortable, stackable table columns ─────────────────────────────────────────
// Every column header is a button. Clicking one runs it through three states —
// added → reversed → removed — and columns STACK in the order they were clicked:
// the first is the primary key, the next breaks its ties, and so on. The rank
// badge on each header and the chips above the table show that order, so the
// stack is never invisible state.

// Substitute quality as a single sortable number: lower is a better option.
// Untried same-metro overlays first, then proven ones nearest-first, then none.
function subRank(a) {
  if (!a || !a.sub) return 9;
  if (a.sub.fresh && a.sub.fresh.length) return 0;
  if (a.sub.proven) return 1 + Math.min(999, a.sub.proven.mi || 0) / 1000;
  return 8;
}

// Column definitions for the Area-code health board. `get` returns the sort
// value; returning null means "no value" and always sinks to the bottom, in
// either direction, so unscorable area codes never displace real ones.
const AC_COLS = [
  { k: 'code',   l: 'Area',             txt: true, get: a => a.code },
  { k: 'label',  l: 'Location',         txt: true, get: a => a.label || '' },
  { k: 'dids',   l: 'DIDs',                        get: a => a.dids },
  { k: 'perDid', l: 'Calls / DID',                 get: a => a.perDid },
  { k: 'depth',  l: 'Depth',                       get: a => a.depth || null },
  { k: 'cr',     l: 'Contact rate',                get: a => a.cr },
  { k: 'dmg',    l: 'Damaged',                     get: a => (a.medianN >= MIN_MEDIAN_N ? a.degradedPct : null) },
  { k: 'dnc',    l: 'DNC / 1k',                    get: a => a.dncPer1k },
  { k: 'burn',   l: 'Burned',                      get: a => (a.ever ? a.burnPct : null) },
  { k: 'sub',    l: 'Local substitute', asc: true, get: a => subRank(a) },
  { k: 'risk',   l: 'Status',                      get: a => a.status.risk },
];

// Column definitions for the South-vs-North "Shared ground" board. Gap is the
// SIGNED difference, so descending puts the biggest South advantage on top and
// ascending puts the biggest North advantage there — one column, both ends.
const VS_COLS = [
  { k: 'code',   l: 'Area',      txt: true, get: e => e.code },
  { k: 'loc',    l: 'Location',  txt: true, get: e => npaLabel(e.code) || '' },
  { k: 'sDids',  l: 'S numbers',            get: e => e.South.dids },
  { k: 'sCalls', l: 'S calls',              get: e => e.South.calls },
  { k: 'sRate',  l: 'S rate',               get: e => e.sCR },
  { k: 'nDids',  l: 'N numbers',            get: e => e.North.dids },
  { k: 'nCalls', l: 'N calls',              get: e => e.North.calls },
  { k: 'nRate',  l: 'N rate',               get: e => e.nCR },
  { k: 'gap',    l: 'Gap',                  get: e => e.gap },
];

// Which way a column sorts on its FIRST click: text and rank-style columns read
// best ascending, measurements read best worst-/highest-first.
const firstDir = c => (c && (c.txt || c.asc)) ? 'asc' : 'desc';

const isBlank = v => v === null || v === undefined || v === ''
  || (typeof v === 'number' && !isFinite(v));

// Build one comparator from a stack of { k, dir } entries.
function stackCmp(stack, cols, fallback) {
  const defs = stack.map(s => ({ s, c: cols.find(c => c.k === s.k) })).filter(x => x.c);
  return (x, y) => {
    for (const { s, c } of defs) {
      const av = c.get(x), bv = c.get(y);
      const an = isBlank(av), bn = isBlank(bv);
      if (an && bn) continue;
      if (an) return 1;          // blanks always last, regardless of direction
      if (bn) return -1;
      const d = c.txt
        ? String(av).localeCompare(String(bv), undefined, { numeric: true })
        : av - bv;
      if (d) return s.dir === 'asc' ? d : -d;
    }
    return fallback ? fallback(x, y) : 0;
  };
}

// Three-state click: not in the stack → append it; in the stack at its first
// direction → reverse it; already reversed → drop it out of the stack.
function cycleSort(setter, cols, k) {
  const first = firstDir(cols.find(c => c.k === k));
  setter(prev => {
    const i = prev.findIndex(s => s.k === k);
    if (i === -1) return [...prev, { k, dir: first }];
    if (prev[i].dir === first) {
      const flipped = first === 'asc' ? 'desc' : 'asc';
      return prev.map((s, j) => (j === i ? { k, dir: flipped } : s));
    }
    return prev.filter((_, j) => j !== i);
  });
}

// Render a full <tr> of clickable headers for the given column set.
function sortHead(cols, stack, onClick) {
  return cols.map(c => {
    const i  = stack.findIndex(s => s.k === c.k);
    const on = i !== -1;
    const at = on ? stack[i].dir : null;
    return h('th', {
      key: c.k,
      className: 'sortable' + (on ? ' sorted' : ''),
      onClick: () => onClick(c.k),
      title: on
        ? 'Sort key ' + (i + 1) + ' of ' + stack.length + ' · '
          + (at === 'asc' ? 'low to high' : 'high to low')
          + ' — click to ' + (at === firstDir(c) ? 'reverse' : 'remove')
        : 'Sort by ' + c.l + '. Click further headers to stack them as tiebreakers.',
    },
      h('span', { className: 'th-in' },
        c.l,
        on && h('span', { className: 'th-rank' }, i + 1),
        h('i', {
          className: 'ti ' + (on ? (at === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down') : 'ti-arrows-sort'),
        }),
      ),
    );
  });
}

// The chip row above a sorted table: names the stack in order and gives one
// click back to the default ordering.
function sortBar(stack, cols, onClick, onClear, defaultLabel) {
  if (!stack.length) {
    return h('div', { className: 'sort-hint' },
      h('i', { className: 'ti ti-arrows-sort' }),
      'Click any column header to sort. Click more headers to stack them — the first is the primary key, the rest break its ties.');
  }
  return h('div', { className: 'sort-bar' },
    h('span', { className: 'sort-bar-l' }, 'Sorted by'),
    ...stack.map((s, i) => {
      const c = cols.find(cc => cc.k === s.k) || { l: s.k };
      return h('button', {
        key: s.k,
        className: 'sort-chip',
        onClick: () => onClick(s.k),
        title: 'Click to reverse, click again to drop it from the stack',
      },
        h('span', { className: 'sort-chip-n' }, i + 1),
        c.l,
        h('i', { className: 'ti ' + (s.dir === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down') }));
    }),
    h('button', { className: 'sort-clear', onClick: onClear },
      h('i', { className: 'ti ti-x' }), defaultLabel || 'Clear'),
  );
}

// ── Grade config ──────────────────────────────────────────────────────────────
const GRADE = {
  A: { lb: 'Clean',   bg: '#d4ecbf', tx: '#1e3f06', br: '#4f8210', rng: '80–100' },
  B: { lb: 'Healthy', bg: '#c4ecdb', tx: '#053c2e', br: '#14856a', rng: '65–79'  },
  C: { lb: 'Watch',   bg: '#f5dfa8', tx: '#3f2200', br: '#9a5e0a', rng: '50–64'  },
  D: { lb: 'At Risk', bg: '#f5d4c4', tx: '#4e1606', br: '#b84520', rng: '35–49'  },
  F: { lb: 'Flagged', bg: '#f5cece', tx: '#5c1010', br: '#cc2828', rng: '0–34'   },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDID(did) {
  const d = String(did).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.substring(1,4)}) ${d.substring(4,7)}-${d.substring(7)}`;
  if (d.length === 10) return `(${d.substring(0,3)}) ${d.substring(3,6)}-${d.substring(6)}`;
  return did;
}
function areaCode(did) {
  const d = String(did).replace(/\D/g, '');
  return d.length === 11 ? d.substring(1,4) : d.substring(0,3);
}
function normPh(s) { return String(s).replace(/\D/g, ''); }

// Sort campaign names: alphabetical on the word part, then numerical on the trailing number.
// "Unassigned" always sorts last.
function campSort(a, b) {
  if (a === 'Unassigned') return 1;
  if (b === 'Unassigned') return -1;
  // Split into word prefix and trailing number, e.g. "Southern Tier 3" -> ["Southern Tier ", 3]
  const parse = s => { const m = s.match(/^(.*?)(\d+)\s*$/); return m ? [m[1].trim(), parseInt(m[2])] : [s, 0]; };
  const [aWord, aNum] = parse(a);
  const [bWord, bNum] = parse(b);
  const wordCmp = aWord.toLowerCase().localeCompare(bWord.toLowerCase());
  return wordCmp !== 0 ? wordCmp : aNum - bNum;
}

// ── Scoring model (calibrated to Convoso Contact Rate Report pool) ─────────────
// Signals: Contacts % (primary), call volume, DNC count (spam flag)
function calcScore({ calls, cr, dncCount }) {
  if (calls < 25) return null; // insufficient data — need at least 25 calls

  let s = 100;

  // Contact rate (-55 max) — recalibrated 2026-08-19 to pool avg ~19% (was ~23%).
  // Steepened so contact rate ALONE can reach D/F; previously the -40 cap floored a
  // zero-DNC number at 57 (C Watch) even at a 0% contact rate.
  if      (cr < 8)  s -= 55;
  else if (cr < 12) s -= 45;
  else if (cr < 16) s -= 34;
  else if (cr < 20) s -= 20;
  else if (cr < 24) s -= 10;
  else if (cr < 28) s -= 4;

  // Call volume (-20 max) — higher volume = more carrier exposure
  if      (calls > 500) s -= 20;
  else if (calls > 300) s -= 14;
  else if (calls > 150) s -= 8;
  else if (calls > 50)  s -= 3;

  // DNC count (-25 max) — strongest spam signal (people actively requesting removal)
  if      (dncCount >= 10) s -= 25;
  else if (dncCount >= 7)  s -= 20;
  else if (dncCount >= 4)  s -= 14;
  else if (dncCount >= 2)  s -= 8;
  else if (dncCount >= 1)  s -= 3;

  return Math.max(0, Math.min(100, s));
}

function getGrade(s) {
  if (s === null) return null;
  return s >= 80 ? 'A' : s >= 65 ? 'B' : s >= 50 ? 'C' : s >= 35 ? 'D' : 'F';
}

// ── Column auto-detection ─────────────────────────────────────────────────────
const MAP_FIELDS = [
  { f: 'did',      lb: 'DID / phone',   req: true  },
  { f: 'calls',    lb: 'Total calls',   req: true  },
  { f: 'answered', lb: 'Calls answered', req: false },
  { f: 'cr',       lb: 'Contacts %',    req: true  },
  { f: 'dncCount', lb: 'DNC count',     req: false },
];

function autoDetect(headers) {
  // Fast path: exact Convoso Contact Rate Report column names
  // (prevents "Contacts" count from stealing "Contacts %" rate slot)
  const has = name => headers.includes(name);
  // Build campaign cols: Convoso puts each campaign NAME as a header ("Campaign 'X'"),
  // and the per-DID count in the blank col N-1 (renamed __col_N-1__ by transformHeader).
  // We store { dataCol, label } so buildPreview can read data from dataCol but name from label.
  // IMPORTANT: the report also has a bare "Campaign" column (col 0) that holds the row's own
  // campaign name — it is NOT a per-campaign count column, so we exclude it here (matching it
  // would corrupt the left-shift offset detection and dump every row into "Unassigned").
  function buildCampaignCols(hdrs) {
    const campPositions = hdrs.reduce((a, h, i) => {
      const t = h.trim();
      if (/^campaign\b/i.test(t) && t.toLowerCase() !== 'campaign') a.push(i);
      return a;
    }, []);
    if (!campPositions.length) return [];
    // Determine offset by checking what's immediately before the first campaign header.
    // If it's blank (__col_N__) or another campaign, all camps are shifted left by 1.
    // Otherwise each camp's data lives in its own column.
    const firstPrev = campPositions[0] > 0 ? hdrs[campPositions[0] - 1] : '';
    const shiftLeft = /^__col_\d+__$/.test(firstPrev) || /^campaign\b/i.test(firstPrev.trim());
    return campPositions.map(i => ({
      dataCol: shiftLeft ? hdrs[i - 1] : hdrs[i],
      label:   hdrs[i],
    }));
  }
  // The bare row-level campaign field, if present — used as the primary campaign signal.
  const campaignField = headers.find(hh => hh.trim().toLowerCase() === 'campaign') || '';
  const campaignCols = buildCampaignCols(headers);
  if (has('DID') && has('Calls') && has('Contacts %')) {
    return {
      did:      'DID',
      calls:    'Calls',
      answered: has('Contacts') ? 'Contacts' : '',
      cr:       'Contacts %',
      dncCount: has('DNC')   ? 'DNC'   : '',
      _campaignCols: campaignCols,
      _campaignField: campaignField,
    };
  }
  // Fallback fuzzy: convert % -> pct so "Contacts %" != "Contacts"
  const n = s => s.toLowerCase().replace(/%/g, 'pct').replace(/[\s_\-\/\(\)]+/g, '');
  const RULES = [
    { f: 'did',      p: ['did','phone','number','callerid','ani','phonenumber'] },
    { f: 'calls',    p: ['totalcalls','totaldials','calls','dials','attempts'] },
    { f: 'cr',       p: ['contactspct','contactspercent','contactpct','contactrate','contactpercent'] },
    { f: 'answered', p: ['contacts','callsanswered','answered','connects'] },
    { f: 'dncCount', p: ['dnccount','dncnum','totaldn','dnc'] },
  ];
  const map = { did: '', calls: '', answered: '', cr: '', dncCount: '' };
  const used = new Set();
  for (const { f, p } of RULES) {
    for (const hdr of headers) {
      if (!used.has(hdr) && p.some(pat => n(hdr) === pat || n(hdr).includes(pat))) {
        map[f] = hdr; used.add(hdr); break;
      }
    }
  }
  map._campaignCols = buildCampaignCols(headers);
  map._campaignField = campaignField;
  return map;
}

// ── CSV template download ─────────────────────────────────────────────────────
function downloadTemplate() {
  const csv = 'DID,Calls,Contacts %,DNC\n12015717472,287,28.5,2\n14172020333,425,16.94,6';
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'convoso_contact_rate_template.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── ID counter (starts above seeded data range) ───────────────────────────────
let _nid = 10000;

// ── Main App ──────────────────────────────────────────────────────────────────
function App() {
  const [dids, setDids]         = useState(() => {
    if (SAVED_POOL) return SAVED_POOL.dids.map(d => ({ ...d, id: _nid++ })); // restore saved pool, reassign ids
    return INIT.map(d => ({ ...d, swapped: false, notes: d.notes || '' }));
  });
  const [filter, setFilter]     = useState('all');
  const [campFilter, setCampFilter] = useState('all');
  const [srt, setSrt]           = useState({ col: 'score', dir: 'asc' });
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ did: '', calls: '', cr: '', dncCount: '', notes: '' });
  const [impOpen, setImpOpen]   = useState(() => !SAVED_POOL); // collapsed when a saved pool was restored
  const [iStep, setIStep]       = useState(0);
  const [isDragOver, setDragOver] = useState(false);
  const [csvRows, setCsvRows]   = useState([]);
  const [csvHdrs, setCsvHdrs]   = useState([]);
  const [colMap, setColMap]     = useState({ did: '', calls: '', answered: '', cr: '', dncCount: '' });
  const [fname, setFname]       = useState('');
  const [preview, setPreview]   = useState([]);
  const [toast, setToast]       = useState(null);
  const [showLegend, setShowLegend] = useState(false);
  const [mapAdjust, setMapAdjust] = useState(false);
  const [showNotify, setShowNotify] = useState(false);
  const [copied, setCopied] = useState(false);
  // Phone(normalized) -> { sentAt, campaign }. Persisted to localStorage.
  const [sentDids, setSentDids] = useState(() => sentStore.load());
  // 'pool' = the working DID table; 'intel' = buying intelligence.
  const [view, setView] = useState('pool');
  // Immutable first-observation stamps, keyed by normalized phone.
  const [firstSeen, setFirstSeen] = useState(() => firstSeenStore.load());
  const [intelTab, setIntelTab] = useState('area');
  const [intelCopied, setIntelCopied] = useState(false);
  const [showLowData, setShowLowData] = useState(false);
  // Area-code board sort stack: [] = the default risk ordering. Each entry is
  // { k, dir }; order in the array IS the sort priority.
  const [acSort, setAcSort] = useState([]);
  // Shared-ground (South vs North) sort stack. [] = the default weighted-gap order.
  const [vsSort, setVsSort] = useState([]);
  // Which recommendation cards have had their area-code list expanded, by rec key.
  const [recOpen, setRecOpen] = useState({});
  const [showThinVs, setShowThinVs] = useState(false);
  const [pvRow, setPvRow] = useState('area');
  const [pvCol, setPvCol] = useState('');          // '' = flat table, all metrics
  const [pvMetric, setPvMetric] = useState('cr');
  const [pvMin, setPvMin] = useState(100);         // calls below this are marked thin
  const [pvSort, setPvSort] = useState({ col: 'calls', dir: 'desc' });
  // Which call center is in view: 'South' (Joshua's), 'North' (his cohort's), or 'all'.
  const [scope, setScope] = useState(SAVED_SCOPE);
  useEffect(() => { try { window.localStorage.setItem(SCOPE_KEY, scope); } catch (e) {} }, [scope]);
  // Which center THIS person works. Null until they answer the one-time prompt.
  const [homeCenter, setHomeCenter] = useState(SAVED_HOME);
  function chooseHome(c) {
    setHomeCenter(c);
    setScope(c);
    try { window.localStorage.setItem(HOME_KEY, c); } catch (e) {}
  }
  // Possessive wording is only correct once we know who is looking.
  const ownLabel = c => homeCenter === null ? ''
    : c === homeCenter ? 'your center'
    : homeCenter === 'all' ? '' : 'the other center';
  // After "Open Email Draft" is clicked, we hold the drafted phones here and
  // ask the user to confirm the email was actually sent (or cancelled).
  const [pendingSend, setPendingSend] = useState(null);
  // Phones the user chose to "Send anyway" this session — forces them into the email
  // even though they're already tracked. Session-only (not persisted).
  const [forceSend, setForceSend] = useState(() => new Set());
  const [didSearch, setDidSearch] = useState('');
  const [page, setPage]           = useState(0); // 0-indexed current page
  const [importedAt, setImportedAt] = useState(() => (SAVED_POOL && SAVED_POOL.importedAt) || null); // { fname, time } — last successful import
  const PAGE_SIZE = 100;

  // Auto-reset to page 0 whenever the visible set changes (tab switch, sort, search, campaign filter)
  // so the user always lands on the highest-priority rows first.
  useEffect(() => { setPage(0); }, [filter, campFilter, srt, didSearch]);

  useEffect(() => { sentStore.save(sentDids); }, [sentDids]);

  // Stamp any DID we have never observed before. Runs on load and after every
  // import; only ever ADDS keys, so a number's age survives pool clears and
  // re-imports. This is what turns lifespan from unmeasurable into measurable.
  useEffect(() => {
    if (!dids.length) return;
    const { map, added } = firstSeenStore.stamp(dids.map(d => d.did));
    if (added) setFirstSeen(map);
  }, [dids]);

  // Persist the DID pool on every change so a refresh restores exactly where you left off
  useEffect(() => {
    if (dids.length > 0) poolStore.save(dids, importedAt);
    else poolStore.clear();
  }, [dids, importedAt]);
  const fileRef = useRef(null);

  // ── Derived data ────────────────────────────────────────────────────────────
  const enrichedAll = useMemo(() => dids.map(d => {
    const s = calcScore(d);
    return { ...d, score: s, grade: getGrade(s), fmt: fmtDID(d.did),
             area: areaCode(d.did), center: centerOf(d.campaign) };
  }), [dids]);

  // How many numbers each center holds — drives the scope switch labels and
  // tells us whether the switch is worth showing at all.
  const centerCounts = useMemo(() => {
    const m = { South: 0, North: 0, Other: 0 };
    for (const d of enrichedAll) m[d.center]++;
    return m;
  }, [enrichedAll]);
  const bothCenters = centerCounts.South > 0 && centerCounts.North > 0;

  // THE scope boundary. Every derived value below reads `enriched`, so scoping
  // here scopes the entire dashboard — counts, tabs, table, campaign chips and
  // the whole intelligence engine — without touching any of them individually.
  // A remembered scope must never strand someone on an empty screen. If the
  // saved center selects nothing out of a report that DOES have numbers — a
  // Northern user opening a Southern-only export, say — fall back to showing
  // everything. The center switch is hidden when only one center is present, so
  // without this there would be no control on screen to recover with.
  const scopeStranded = scope !== 'all' && enrichedAll.length > 0
    && !enrichedAll.some(d => d.center === scope);
  const activeScope = scopeStranded ? 'all' : scope;
  const enriched = useMemo(
    () => activeScope === 'all' ? enrichedAll : enrichedAll.filter(d => d.center === activeScope),
    [enrichedAll, activeScope]
  );

  // ── Sent / replacement tracking (two states: 'sent' = in process, 'replaced' = done) ──
  const entryOf    = phone => sentDids[normPh(phone)];
  const isSent     = phone => { const e = entryOf(phone); return !!e && e.status === 'sent'; };
  const isReplaced = phone => { const e = entryOf(phone); return !!e && e.status === 'replaced'; };

  function markSent(dids_) {
    const sentPhones = new Set(dids_.map(d => normPh(d.did)));
    // Clear the swap flag on confirmed numbers so they leave the queue entirely
    // (prevents them re-appearing under "already tracked").
    setDids(prev => prev.map(d => sentPhones.has(normPh(d.did)) ? { ...d, swapped: false } : d));
    setSentDids(prev => {
      const next = { ...prev };
      dids_.forEach(d => {
        const ph = normPh(d.did);
        const e = prev[ph] || {};
        // If this number was previously replaced, re-sending it counts as a resend.
        const resendCount = (e.resendCount || 0) + (e.status === 'replaced' ? 1 : 0);
        next[ph] = {
          status: 'sent',
          sentAt: Date.now(),
          campaign: d.campaign || e.campaign || '',
          resendCount,
        };
      });
      return next;
    });
  }
  // "Send anyway" on a tracked number: keep its record but flip it back to In Process
  // (re-queued for replacement), incrementing the resend counter if it was replaced.
  function resendTracked(phone, campaign) {
    setSentDids(prev => {
      const ph = normPh(phone);
      const e = prev[ph] || {};
      const resendCount = (e.resendCount || 0) + (e.status === 'replaced' ? 1 : 0);
      return { ...prev, [ph]: { status: 'sent', sentAt: Date.now(), campaign: e.campaign || campaign || '', resendCount } };
    });
  }
  // Mark replaced: keep on record (for 60 days) so old reports show "Already Replaced".
  function markReplaced(phone) {
    setSentDids(prev => {
      const ph = normPh(phone);
      const e = prev[ph] || {};
      return { ...prev, [ph]: { status: 'replaced', sentAt: e.sentAt || Date.now(), replacedAt: Date.now(), campaign: e.campaign || '', resendCount: e.resendCount || 0 } };
    });
  }
  // Remove entirely (used by "Send anyway" so the number rejoins the email).
  function removeEntry(phone) {
    setSentDids(prev => {
      const next = { ...prev };
      delete next[normPh(phone)];
      return next;
    });
  }
  // Manual purge of all replaced numbers.
  function purgeReplaced() {
    setSentDids(prev => {
      const next = {};
      for (const [ph, e] of Object.entries(prev)) if (e.status !== 'replaced') next[ph] = e;
      return next;
    });
  }
  // Restore: remove the 'replaced' record entirely so a DID re-enters the normal pool
  // and can be flagged for swap again.
  function restoreToActive(phone) {
    removeEntry(phone);
  }

  const counts = useMemo(() => {
    // Single-pass accumulator — one loop instead of 10 separate .filter() calls over enriched
    let total = 0, lowData = 0, dncAlert = 0, flagged = 0, atRisk = 0,
        clean = 0, watch = 0, swapQ = 0, inProc = 0, replaced = 0,
        hiSum = 0, hiCount = 0;
    for (const d of enriched) {
      const sent     = isSent(d.did);
      const replacedD = isReplaced(d.did);
      if (sent)     { inProc++; continue; }   // workflow-only — excluded from all other counts
      if (replacedD){ replaced++; continue; } // workflow-only — excluded from all other counts
      total++;
      if (d.calls < 25)  lowData++;
      if ((d.dncCount || 0) >= 4 && (d.calls || 0) > 50 && (d.cr || 0) <= 25) dncAlert++;
      if (d.grade === 'F') flagged++;
      if (d.grade === 'D') atRisk++;
      if (d.grade === 'A' || d.grade === 'B') clean++;
      if (d.grade === 'C') watch++;
      if (d.swapped) swapQ++;
      if (d.calls >= 25) { hiSum += d.cr; hiCount++; }
    }
    return { total, lowData, dncAlert, flagged, atRisk, clean, watch, swapQ, inProc, replaced,
             avgCR: hiCount ? (hiSum / hiCount).toFixed(1) : '—' };
  }, [enriched, sentDids]);

  // Same shape as `counts`, but scoped to the selected campaign. Feeds the status TABS
  // so their numbers change to match whatever campaign you're viewing. When no campaign
  // is selected it's identical to the global counts. The top health bar keeps using the
  // global `counts` (always all campaigns).
  const viewCounts = useMemo(() => {
    if (campFilter === 'all') return counts;
    let total = 0, lowData = 0, dncAlert = 0, flagged = 0, atRisk = 0,
        clean = 0, watch = 0, swapQ = 0, inProc = 0, replaced = 0,
        hiSum = 0, hiCount = 0;
    for (const d of enriched) {
      if ((d.campaign || '') !== campFilter) continue;
      const sent      = isSent(d.did);
      const replacedD = isReplaced(d.did);
      if (sent)      { inProc++; continue; }
      if (replacedD) { replaced++; continue; }
      total++;
      if (d.calls < 25)  lowData++;
      if ((d.dncCount || 0) >= 4 && (d.calls || 0) > 50 && (d.cr || 0) <= 25) dncAlert++;
      if (d.grade === 'F') flagged++;
      if (d.grade === 'D') atRisk++;
      if (d.grade === 'A' || d.grade === 'B') clean++;
      if (d.grade === 'C') watch++;
      if (d.swapped) swapQ++;
      if (d.calls >= 25) { hiSum += d.cr; hiCount++; }
    }
    return { total, lowData, dncAlert, flagged, atRisk, clean, watch, swapQ, inProc, replaced,
             avgCR: hiCount ? (hiSum / hiCount).toFixed(1) : '—' };
  }, [enriched, sentDids, campFilter, counts]);

  // Queued (swap-flagged) DIDs. In Process numbers are locked out of swapping entirely,
  // so the only "already tracked" case left is a previously-REPLACED number being re-flagged.
  const queued       = useMemo(() => enriched.filter(d => d.swapped), [enriched]);
  const queuedNew    = useMemo(() => queued.filter(d => forceSend.has(normPh(d.did)) || !isReplaced(d.did)), [queued, sentDids, forceSend]);
  const queuedResent = useMemo(() => queued.filter(d => !forceSend.has(normPh(d.did)) && isReplaced(d.did)), [queued, sentDids, forceSend]);
  // DIDs currently in the replacement process (status 'sent'), newest first.
  const inProcess    = useMemo(() => {
    return Object.entries(sentDids).filter(([, m]) => m.status === 'sent').map(([phone, meta]) => {
      const live = enriched.find(d => normPh(d.did) === phone);
      return { phone, fmt: live ? live.fmt : fmtDID(phone), campaign: meta.campaign || (live && live.campaign) || '', sentAt: meta.sentAt, resendCount: meta.resendCount || 0 };
    }).sort((a, b) => b.sentAt - a.sentAt);
  }, [sentDids, enriched]);
  // DIDs confirmed replaced (status 'replaced'), kept on record for 60 days, newest first.
  const replacedList = useMemo(() => {
    return Object.entries(sentDids).filter(([, m]) => m.status === 'replaced').map(([phone, meta]) => {
      const live = enriched.find(d => normPh(d.did) === phone);
      const daysLeft = meta.replacedAt ? Math.max(0, Math.ceil((REPLACED_TTL_MS - (Date.now() - meta.replacedAt)) / 86400000)) : null;
      return { phone, fmt: live ? live.fmt : fmtDID(phone), campaign: meta.campaign || (live && live.campaign) || '', replacedAt: meta.replacedAt, daysLeft, resendCount: meta.resendCount || 0 };
    }).sort((a, b) => (b.replacedAt || 0) - (a.replacedAt || 0));
  }, [sentDids, enriched]);

  // The Notify Convoso panel only appears when numbers are actively queued to email.
  // In Process / Replaced history is shown in the status tabs and the main table, not here.
  const hasNotifyContent = queued.length > 0 || !!pendingSend;

  // Build the email body for whichever set of DIDs is being sent.
  function buildEmailHref(list) {
    const body = 'Hi Convoso Support,\n\nPlease replace the following DIDs flagged for spam risk:\n\n'
      + list.map(d => d.campaign ? d.fmt + '  (' + d.campaign + ')' : d.fmt).join('\n')
      + '\n\nThank you,\nJosh Grigson\nOcean Canyon Properties';
    return 'https://outlook.office.com/mail/deeplink/compose?to=' + encodeURIComponent('Help@convoso.com')
      + '&subject=' + encodeURIComponent('DID Replacement Request')
      + '&body=' + encodeURIComponent(body);
  }

  // Pre-built Sets for O(1) per-row lookups — avoids re-evaluating the sentDids object
  // on every row in large tables (800–2000 DIDs).
  const sentSet     = useMemo(() => new Set(Object.entries(sentDids).filter(([,m]) => m.status === 'sent').map(([ph]) => ph)),     [sentDids]);
  const replacedSet = useMemo(() => new Set(Object.entries(sentDids).filter(([,m]) => m.status === 'replaced').map(([ph]) => ph)), [sentDids]);

  const filtered = useMemo(() => {
    let rows = enriched;
    // Workflow tabs show only their own set; all other tabs exclude In Process + Replaced entirely
    const isWorkflowTab = filter === 'inproc' || filter === 'replaced';
    if (!isWorkflowTab) rows = rows.filter(d => !sentSet.has(normPh(d.did)) && !replacedSet.has(normPh(d.did)));
    if      (filter === 'clean')   rows = rows.filter(d => d.grade === 'A' || d.grade === 'B');
    else if (filter === 'watch')   rows = rows.filter(d => d.grade === 'C');
    else if (filter === 'atrisk')  rows = rows.filter(d => d.grade === 'D' || d.grade === 'F');
    else if (filter === 'flagged') rows = rows.filter(d => d.grade === 'F');
    else if (filter === 'dnc')     rows = rows.filter(d => (d.dncCount || 0) >= 4 && (d.calls || 0) > 50 && (d.cr || 0) <= 25);
    else if (filter === 'low')     rows = rows.filter(d => d.calls < 25);
    else if (filter === 'swap')    rows = rows.filter(d => d.swapped);
    else if (filter === 'inproc')  rows = rows.filter(d => sentSet.has(normPh(d.did)));
    else if (filter === 'replaced') rows = rows.filter(d => replacedSet.has(normPh(d.did)));
    if (campFilter !== 'all') rows = rows.filter(d => (d.campaign || '') === campFilter);
    if (didSearch.trim()) {
      const q = didSearch.replace(/\D/g, '');
      rows = rows.filter(d => String(d.did).includes(q) || (q.length < 4 && normPh(d.did).includes(q)));
    }
    const GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };
    const sortKey = (d) => {
      // Grade is a letter (A–F) or null (Low Data) — map to a numeric rank so it
      // orders A→F instead of string-comparing, and nulls always sink to the bottom.
      if (srt.col === 'grade') return (d.grade in GRADE_RANK) ? GRADE_RANK[d.grade] : 99;
      let v = d[srt.col];
      if (v === null || v === undefined) return Infinity; // missing values always last
      if (typeof v === 'string') return v.toLowerCase();
      return v;
    };
    return [...rows].sort((a, b) => {
      const av = sortKey(a), bv = sortKey(b);
      if (av < bv) return srt.dir === 'asc' ? -1 : 1;
      if (av > bv) return srt.dir === 'asc' ? 1 : -1;
      return 0; // equal keys → stable, no blank-render churn
    });
  }, [enriched, filter, srt, campFilter, sentDids, didSearch, sentSet, replacedSet]);

  // Distinct campaigns derived from already-filtered rows — avoids duplicating the full filter logic.
  const campaigns = useMemo(() => {
    const m = new Map();
    for (const d of filtered) { const c = d.campaign || 'Unassigned'; m.set(c, (m.get(c) || 0) + 1); }
    return [...m.entries()].sort(([a], [b]) => campSort(a, b));
  }, [filtered]);

  // ALL campaigns in the pool — independent of the active campaign filter, so every
  // campaign chip stays visible when one is selected (just highlight the active one).
  const allCampaigns = useMemo(() => {
    const m = new Map();
    for (const d of enriched) { const c = d.campaign || 'Unassigned'; m.set(c, (m.get(c) || 0) + 1); }
    return [...m.entries()].sort(([a], [b]) => campSort(a, b));
  }, [enriched]);

  // Per-campaign aggregates over the ENTIRE filtered set (every page, not just the
  // <=100 rows currently on screen). The campaign band header reads its DID count,
  // total calls, total answered, and pooled contact rate from here so those numbers
  // stay fixed when you sort or page -- mirroring the scorecard total instead of
  // recomputing off whatever 100 rows happen to be visible.
  const campTotals = useMemo(() => {
    const m = new Map();
    for (const d of filtered) {
      const c = d.campaign || 'Unassigned';
      let s = m.get(c);
      if (!s) { s = { count: 0, calls: 0, ans: 0, flagged: 0 }; m.set(c, s); }
      s.count++;
      s.calls += d.calls || 0;
      s.ans   += d.answered || 0;
      if (d.grade === 'D' || d.grade === 'F') s.flagged++;
    }
    return m;
  }, [filtered]);

  // Paginated slice — only PAGE_SIZE rows reach the DOM at a time.
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const safePage   = Math.min(page, Math.max(0, totalPages - 1));
  const pageRows   = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Count DIDs with no campaign — signals a header-format mismatch in the dropped CSV.
  const unassignedCount = useMemo(
    () => enriched.filter(d => !d.campaign).length,
    [enriched]
  );

  // ── Buying intelligence ─────────────────────────────────────────────────────
  // Built for local presence: the area code is set by the lead, so the output
  // is not "where to buy" but "how hard is each area code burning, how many
  // replacements does it need, and is there a healthier number that still
  // reaches the same person". Everything is derived from the pool snapshot plus
  // the timestamped sent/replaced ledger -- where a figure is not yet
  // measurable the panel says so instead of guessing.
  const intel = useMemo(() => {
    const now = Date.now();
    // The ledger records the campaign a number was sent under, so it partitions
    // by center too. Older records predating campaign capture carry no campaign;
    // those fall back to which center's pool the number currently sits in rather
    // than being dropped, which would silently understate burn.
    const scopedPhones = new Set(enriched.map(d => normPh(d.did)));
    const ledger = Object.entries(sentDids)
      .map(([ph, e]) => ({ ph, ...e }))
      .filter(e => {
        if (activeScope === 'all') return true;
        const c = centerOf(e.campaign);
        if (c === 'North' || c === 'South') return c === activeScope;
        return scopedPhones.has(e.ph);
      });

    // ── Per-area-code aggregation ────────────────────────────────────────────
    const acMap = new Map();
    const ac = k => {
      let a = acMap.get(k);
      if (!a) {
        a = { code: k, dids: 0, calls: 0, ans: 0, dnc: 0, scorable: 0, atRisk: 0,
              scoreSum: 0, burned: 0, untouched: 0, crs: [], members: [] };
        acMap.set(k, a);
      }
      return a;
    };
    for (const d of enriched) {
      const ph = normPh(d.did);
      if (replacedSet.has(ph)) continue;
      const a = ac(areaCode(d.did));
      a.dids++;
      if (!sentSet.has(ph)) a.untouched++;
      a.calls += d.calls || 0;
      a.ans   += d.answered || 0;
      a.dnc   += d.dncCount || 0;
      if (d.score !== null) {
        a.scorable++; a.scoreSum += d.score;
        a.crs.push(d.cr || 0);
        a.members.push(d);
        if (d.grade === 'D' || d.grade === 'F') a.atRisk++;
      }
    }
    for (const e of ledger) ac(areaCode(e.ph)).burned++;

    // Pool baselines (DNC only -- contact rate is never compared across regions).
    let baseCalls = 0, baseAns = 0, baseDnc = 0, baseDids = 0;
    for (const a of acMap.values()) { baseCalls += a.calls; baseAns += a.ans; baseDnc += a.dnc; baseDids += a.dids; }
    const base = {
      cr:      baseCalls ? (baseAns / baseCalls) * 100 : 0,
      dnc1k:   baseCalls ? (baseDnc / baseCalls) * 1000 : 0,
      perDid:  baseDids ? baseCalls / baseDids : 0,
    };

    const areaRows = [...acMap.values()].map(a => {
      a.ever = a.untouched + a.burned;
      // In-area-code median contact rate -- the yardstick a number is judged
      // against, so regional answer-rate differences cancel out.
      const sortedCR = a.crs.slice().sort((x, y) => x - y);
      a.medianN  = sortedCR.length;
      a.medianCR = median(sortedCR);
      a.degraded = (a.medianCR !== null && a.medianN >= MIN_MEDIAN_N)
        ? a.members.filter(d => (d.cr || 0) < a.medianCR * DEGRADED_FRAC).length
        : 0;
      a.degradedPct = a.medianN ? (a.degraded / a.medianN) * 100 : 0;
      const cr        = a.calls ? (a.ans / a.calls) * 100 : 0;
      const dncPer1k  = a.calls ? (a.dnc / a.calls) * 1000 : 0;
      const atRiskPct = a.scorable ? (a.atRisk / a.scorable) * 100 : 0;
      const burnPct   = a.ever ? (a.burned / a.ever) * 100 : 0;
      const avgScore  = a.scorable ? a.scoreSum / a.scorable : null;
      const perDid    = a.dids ? a.calls / a.dids : 0;
      const depth     = base.perDid ? perDid / base.perDid : 0;
      return { ...a, cr, dncPer1k, atRiskPct, burnPct, avgScore, perDid, depth,
               label: npaLabel(a.code), st: npaState(a.code),
               status: acStatus({ ...a, ever: a.ever }, base) };
    }).sort((x, y) => {
      const rx = x.status.risk, ry = y.status.risk;
      if (rx === null && ry === null) return y.dids - x.dids;
      if (rx === null) return 1;
      if (ry === null) return -1;
      return ry - rx || y.dids - x.dids;
    });

    const byCode = new Map(areaRows.map(r => [r.code, r]));
    const healthy = areaRows.filter(r => r.status.key === 'ok' && NPA_GEO[r.code]);
    const held    = new Set(areaRows.map(r => r.code));

    // ── Substitutes that preserve local presence ─────────────────────────────
    // Two kinds, in priority order:
    //   proven  — an area code already held here, healthy, and near enough
    //   fresh   — a same-metro overlay NOT currently held, so it carries no
    //             burn history at all; the strongest option when one exists
    function substitutes(code) {
      const out = { proven: null, fresh: [] };
      if (!NPA_GEO[code]) return out;
      const scored = healthy
        .filter(r => r.code !== code)
        .map(r => ({ r, mi: npaMiles(code, r.code) }))
        .filter(x => x.mi !== null && x.mi <= LOCAL_MI)
        .sort((x, y) => x.mi - y.mi || (y.r.avgScore || 0) - (x.r.avgScore || 0));
      out.proven = scored.length ? scored[0] : null;
      for (const other of Object.keys(NPA_GEO)) {
        if (other === code || held.has(other)) continue;
        const mi = npaMiles(code, other);
        if (mi !== null && mi <= SAME_CITY_MI) out.fresh.push({ code: other, mi });
      }
      out.fresh.sort((x, y) => x.mi - y.mi);
      out.fresh = out.fresh.slice(0, 4);
      return out;
    }
    for (const r of areaRows) {
      r.sub = (r.status.key === 'refresh' || r.status.key === 'cycle') ? substitutes(r.code) : null;
    }

    // ── Burn rate + forecast ─────────────────────────────────────────────────
    const sentTimes = ledger.map(e => e.sentAt).filter(Boolean).sort((a, b) => a - b);
    const fsTimes   = Object.values(firstSeen).filter(Boolean);
    const earliest  = Math.min(
      TRACK_START,
      sentTimes.length ? sentTimes[0] : TRACK_START,
      fsTimes.length ? Math.min.apply(null, fsTimes) : TRACK_START
    );
    const spanDays = Math.max(1, (now - earliest) / DAY_MS);
    const inWin  = d => sentTimes.filter(t => now - t <= d * DAY_MS).length;
    const burn30 = inWin(30), burn60 = inWin(60), burn90 = inWin(90);
    const winDays = Math.min(90, spanDays);
    const perDay  = inWin(winDays) / winDays;
    const perWeek = perDay * 7;

    const turnarounds = ledger
      .filter(e => e.replacedAt && e.sentAt && e.replacedAt >= e.sentAt)
      .map(e => (e.replacedAt - e.sentAt) / DAY_MS)
      .sort((a, b) => a - b);
    const medTurn = median(turnarounds);

    const backlog = enriched.filter(d => {
      const ph = normPh(d.did);
      return !sentSet.has(ph) && !replacedSet.has(ph) && (d.grade === 'D' || d.grade === 'F');
    }).length;
    const inProcN = ledger.filter(e => e.status === 'sent').length;
    const forecast = d => Math.round(backlog + perDay * d);
    const f30 = forecast(30), f60 = forecast(60), f90 = forecast(90);
    const order90 = Math.ceil(f90 * 1.2);
    const mature  = spanDays >= 30 && sentTimes.length >= 5;

    // ── Where those numbers should be bought ─────────────────────────────────
    // An ALLOCATION of the pool-level forecast across area codes by current
    // risk weight, not a per-area-code measurement -- there is nowhere near
    // enough per-code history to measure each one independently, and pretending
    // otherwise would put false precision on a purchase order.
    const weightOf = r => (r.atRisk + r.degraded) + r.burned * 0.5;
    const totalW = areaRows.reduce((t, r) => t + weightOf(r), 0);
    // Largest-remainder allocation: rounding each share independently loses
    // numbers (38 forecast came out as 29 allocated), and a purchase order that
    // does not add up to the figure printed above it is worse than no plan.
    let orderPlan = [];
    if (totalW > 0) {
      const raw = areaRows
        .map(r => ({ r, exact: order90 * weightOf(r) / totalW }))
        .filter(x => x.exact > 0);
      raw.forEach(x => { x.qty = Math.floor(x.exact); x.rem = x.exact - x.qty; });
      let short = order90 - raw.reduce((t, x) => t + x.qty, 0);
      raw.slice().sort((a, b) => b.rem - a.rem).forEach(x => { if (short > 0) { x.qty++; short--; } });
      orderPlan = raw.filter(x => x.qty > 0)
        .map(x => ({ ...x.r, w: weightOf(x.r), qty: x.qty }))
        .sort((a, b) => b.qty - a.qty);
    }
    const orderPlanned = orderPlan.reduce((t, r) => t + r.qty, 0);

    // ── Volume burn curve ────────────────────────────────────────────────────
    const BUCKETS = [[0, 50], [50, 100], [100, 200], [200, 350], [350, 500], [500, Infinity]];
    const scorablePool = enriched.filter(d => d.score !== null && !replacedSet.has(normPh(d.did)));
    const curve = BUCKETS.map(([lo, hi]) => {
      const b = scorablePool.filter(d => (d.calls || 0) >= lo && (d.calls || 0) < hi);
      const calls = b.reduce((t, d) => t + (d.calls || 0), 0);
      const ans   = b.reduce((t, d) => t + (d.answered || 0), 0);
      const dnc   = b.reduce((t, d) => t + (d.dncCount || 0), 0);
      const risky = b.filter(d => d.grade === 'D' || d.grade === 'F').length;
      return {
        lb: hi === Infinity ? lo + '+' : lo + '-' + hi,
        n: b.length,
        cr: calls ? (ans / calls) * 100 : null,
        dncPer1k: calls ? (dnc / calls) * 1000 : null,
        atRiskPct: b.length ? (risky / b.length) * 100 : null,
      };
    });
    const poolCalls = scorablePool.reduce((t, d) => t + (d.calls || 0), 0);
    const poolAns   = scorablePool.reduce((t, d) => t + (d.answered || 0), 0);
    const poolCR    = poolCalls ? (poolAns / poolCalls) * 100 : 0;
    const rotateBand = curve.find(c => c.n >= 5 && c.cr !== null && c.cr < poolCR * 0.85) || null;
    const rotateAt   = rotateBand ? rotateBand.lb : null;
    const rotateN    = rotateBand ? rotateBand.n : 0;

    // ── Campaign exposure ────────────────────────────────────────────────────
    const cMap = new Map();
    for (const d of enriched) {
      const ph = normPh(d.did);
      if (replacedSet.has(ph)) continue;
      const k = d.campaign || 'Unassigned';
      let c = cMap.get(k);
      if (!c) { c = { name: k, dids: 0, calls: 0, ans: 0, scorable: 0, atRisk: 0, burned: 0 }; cMap.set(k, c); }
      c.dids++; c.calls += d.calls || 0; c.ans += d.answered || 0;
      if (d.score !== null) { c.scorable++; if (d.grade === 'D' || d.grade === 'F') c.atRisk++; }
    }
    for (const e of ledger) { const c = cMap.get(e.campaign || 'Unassigned'); if (c) c.burned++; }
    let campDids = 0, campCalls = 0;
    for (const c of cMap.values()) { campDids += c.dids; campCalls += c.calls; }
    const poolPerDid = campDids ? campCalls / campDids : 0;
    const campRows = [...cMap.values()].map(c => ({
      ...c,
      perDid: c.dids ? c.calls / c.dids : 0,
      cr: c.calls ? (c.ans / c.calls) * 100 : 0,
      atRiskPct: c.scorable ? (c.atRisk / c.scorable) * 100 : 0,
      exposure: poolPerDid && c.dids ? (c.calls / c.dids) / poolPerDid : 0,
    })).sort((a, b) => b.perDid - a.perDid);

    // ── Lifespan ─────────────────────────────────────────────────────────────
    const lifespans = ledger
      .filter(e => firstSeen[e.ph] && e.sentAt && e.sentAt > firstSeen[e.ph])
      .map(e => (e.sentAt - firstSeen[e.ph]) / DAY_MS)
      .sort((a, b) => a - b);
    const medLife = lifespans.length >= 5 ? median(lifespans) : null;
    const stamped = enriched.filter(d => firstSeen[normPh(d.did)]).length;

    // ── Recommendations ──────────────────────────────────────────────────────
    const recs = [];
    const refresh = areaRows.filter(r => r.status.key === 'refresh');
    const cycle   = areaRows.filter(r => r.status.key === 'cycle');

    if (refresh.length) {
      const r = refresh[0];
      let d = r.code + ' (' + r.label + ') is worst: ';
      const bits = [];
      if (r.medianN >= MIN_MEDIAN_N && r.degraded) {
        bits.push(r.degraded + ' of its ' + r.medianN + ' numbers have fallen below 60% of the contact rate the rest of that area code gets');
      }
      if (r.dncPer1k >= base.dnc1k * 1.35) bits.push(r.dncPer1k.toFixed(1) + ' DNC per 1k against a ' + base.dnc1k.toFixed(1) + ' pool average');
      if (r.burned) bits.push(r.burnPct.toFixed(0) + '% of every number ever held there has burned');
      d += (bits.join('; ') || 'multiple health signals are elevated') + '.';
      if (r.sub && r.sub.fresh.length) {
        d += ' ' + r.sub.fresh.map(f => f.code).join('/') + ' cover the same metro and you hold none of them — no burn history at all, and local presence is unchanged.';
      } else if (r.sub && r.sub.proven) {
        d += ' Closest healthy area code you already hold is ' + r.sub.proven.r.code + ' (' + r.sub.proven.r.label + '), '
           + (r.sub.proven.mi < 1 ? 'same metro' : Math.round(r.sub.proven.mi) + ' mi away') + '.';
      } else {
        d += ' No healthy substitute within ' + LOCAL_MI + ' miles — you have to cycle in place here, just faster.';
      }
      // `t` carries EVERY code — it feeds the copy/export summary, which should
      // never be a truncated view. `codes` + `shown` drive the expandable
      // on-screen list; the card shows `shown` of them until you open it.
      recs.push({
        tone: 'bad',
        key: 'refresh',
        t: 'Refresh now: ' + refresh.map(x => x.code).join(', '),
        pre: 'Refresh now: ',
        codes: refresh.map(x => ({ code: x.code, label: x.label })),
        shown: 5,
        d,
      });
    }
    if (cycle.length) {
      recs.push({
        tone: 'warn',
        key: 'cycle',
        t: 'Cycle faster in ' + cycle.map(x => x.code).join(', '),
        pre: 'Cycle faster in ',
        codes: cycle.map(x => ({ code: x.code, label: x.label })),
        shown: 6,
        d: 'These are not dead, but they are running hotter than the rest of the pool. Keep the local presence — replace numbers there on a shorter interval rather than waiting for a spam flag.',
      });
    }
    const thin = areaRows.filter(r => r.depth >= 1.4 && r.dids >= MIN_AC_DIDS && r.status.key !== 'low')
                         .sort((a, b) => b.depth - a.depth);
    if (thin.length) {
      const t0 = thin[0];
      recs.push({
        tone: 'warn',
        key: 'thin',
        t: 'Add numbers in ' + thin.map(x => x.code).join(', ') + ' — you are working too few too hard',
        pre: 'Add numbers in ',
        codes: thin.map(x => ({ code: x.code, label: x.label })),
        shown: 4,
        post: ' — you are working too few too hard',
        d: t0.code + ' (' + t0.label + ') is pushing ' + t0.perDid.toFixed(0) + ' calls per number against a '
           + base.perDid.toFixed(0) + ' pool average (' + t0.depth.toFixed(2) + '×). Local presence means you cannot move that volume elsewhere, '
           + 'so the only lever is more numbers in the same area code — otherwise you are just burning the ones you have faster.',
      });
    }
    if (rotateAt) {
      recs.push({
        tone: 'warn',
        t: 'Rotate numbers before the ' + rotateAt + ' call band',
        d: 'Contact rate falls more than 15% below the ' + poolCR.toFixed(1)
           + '% pool average once a number passes that volume. Retiring on volume rather than waiting for a spam flag gets ahead of the carriers. '
           + 'Read with the sample in mind: ' + rotateN + ' of ' + scorablePool.length + ' scorable numbers sit in that band.',
      });
    }
    if (campRows.length > 1 && campRows[0].exposure >= 1.25) {
      const c = campRows[0];
      recs.push({
        tone: 'warn',
        t: c.name + ' burns numbers fastest',
        d: 'It runs ' + c.perDid.toFixed(0) + ' calls per DID versus a ' + poolPerDid.toFixed(0)
           + ' pool average (' + c.exposure.toFixed(2) + '×). Either widen its DID pool or expect to replace its numbers roughly '
           + c.exposure.toFixed(1) + '× as often.',
      });
    }
    if (sentTimes.length) {
      recs.push({
        tone: 'info',
        t: 'Plan for ~' + f90 + ' replacements over the next 90 days',
        d: 'Measured burn is ' + perWeek.toFixed(1) + ' numbers per week across ' + Math.round(spanDays)
           + ' days of tracking, on top of ' + backlog + ' already at risk. Order about ' + order90
           + ' to cover it with a 20% buffer'
           + (medTurn !== null ? ', and place it ' + medTurn.toFixed(0) + '+ days ahead — that is your median Convoso turnaround.' : '.')
           + (mature ? '' : ' Treat this as an early estimate until 30 days of tracking accumulate.')
           + ' The Burn & order tab breaks that quantity down by area code.',
      });
    }

    return {
      areaRows, campRows, curve, recs, poolCR, poolPerDid, rotateAt, base,
      rotateN, scorableN: scorablePool.length, orderPlan, orderPlanned,
      burn30, burn60, burn90, perDay, perWeek, spanDays, medTurn,
      backlog, inProcN, f30, f60, f90, order90, mature,
      medLife, lifespanN: lifespans.length, stamped, earliest,
      ledgerN: ledger.length,
      refreshN: refresh.length, cycleN: cycle.length, thinN: thin.length,
    };
  }, [enriched, sentDids, sentSet, replacedSet, firstSeen, activeScope]);

  // ── Pivot ───────────────────────────────────────────────────────────────────
  // Rows = one dimension; optionally columns = a second, with a single chosen
  // metric per cell. Respects the active scope so it composes with everything
  // else rather than being a separate world.
  const pivot = useMemo(() => {
    const rowDim = PIVOT_DIMS.find(x => x.k === pvRow) || PIVOT_DIMS[0];
    const colDim = pvCol ? PIVOT_DIMS.find(x => x.k === pvCol) : null;
    const rows = new Map();
    const colSeen = new Map();      // every column that appears, total or not
    for (const d of enriched) {
      if (replacedSet.has(normPh(d.did))) continue;
      const rk = String(rowDim.get(d) ?? '—');
      let r = rows.get(rk);
      if (!r) { r = { key: rk, total: pivotCell(), cells: new Map() }; rows.set(rk, r); }
      pivotAdd(r.total, d);
      if (colDim) {
        const ck = String(colDim.get(d) ?? '—');
        let c = r.cells.get(ck);
        if (!c) { c = pivotCell(); r.cells.set(ck, c); }
        pivotAdd(c, d);
        let cs = colSeen.get(ck);
        if (!cs) { cs = pivotCell(); colSeen.set(ck, cs); }
        pivotAdd(cs, d);
      }
    }

    // Totals are rebuilt from the ROWS so a dimension can hold some of them out.
    // Columns still come from every row — excluding Canada from the total must
    // not make a whole column disappear from the grid.
    const outOfTotal = rowDim.outOfTotal || (() => false);
    const merge = (dst, src) => {
      dst.dids += src.dids; dst.calls += src.calls; dst.ans += src.ans; dst.dnc += src.dnc;
      dst.scorable += src.scorable; dst.risky += src.risky; dst.scoreSum += src.scoreSum;
    };
    const grand = pivotCell();
    const colTotals = new Map();
    const excluded = [];
    for (const r of rows.values()) {
      if (outOfTotal(r.key)) { excluded.push(r.key); continue; }
      merge(grand, r.total);
      for (const [ck, cell] of r.cells) {
        let ct = colTotals.get(ck);
        if (!ct) { ct = pivotCell(); colTotals.set(ck, ct); }
        merge(ct, cell);
      }
    }
    const cols = [...colSeen.keys()].sort((a, b) => {
      if (colDim && colDim.ord) return a.localeCompare(b);   // keep the natural sequence
      return (colSeen.get(b).calls - colSeen.get(a).calls) || a.localeCompare(b);
    });
    // Rows whose area code is not in the geography table: real numbers, but not
    // known to be US, so the total must not silently claim them as states.
    const unmappedInTotal = [...rows.keys()].some(k => k === '—' && !outOfTotal(k));
    return { rowDim, colDim, rows: [...rows.values()], cols, colTotals, grand,
             excluded, unmappedInTotal, totalRows: rows.size - excluded.length };
  }, [enriched, replacedSet, pvRow, pvCol]);

  function exportPivotCSV() {
    const m = PIVOT_METRICS.find(x => x.k === pvMetric) || PIVOT_METRICS[0];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    let lines;
    if (pivot.colDim) {
      lines = [[q(pivot.rowDim.l), ...pivot.cols.map(q), q('Total')].join(',')];
      for (const r of pivot.rows) {
        lines.push([q(r.key), ...pivot.cols.map(c => {
          const cell = r.cells.get(c); const v = cell ? m.agg(cell) : null;
          return v === null || v === undefined ? '' : (typeof v === 'number' ? v.toFixed(2) : v);
        }), (m.agg(r.total) ?? '') === '' ? '' : m.agg(r.total).toFixed(2)].join(','));
      }
    } else {
      lines = [[q(pivot.rowDim.l), ...PIVOT_METRICS.map(x => q(x.l))].join(',')];
      for (const r of pivot.rows) {
        lines.push([q(r.key), ...PIVOT_METRICS.map(x => {
          const v = x.agg(r.total);
          return v === null || v === undefined ? '' : v.toFixed(2);
        })].join(','));
      }
    }
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
    a.download = 'did_pivot_' + pvRow + (pvCol ? '_by_' + pvCol : '') + '_'
               + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // ── Head-to-head: Southern vs Northern center ───────────────────────────────
  // Computed from the FULL pool, not the active scope, since the whole point is
  // to see both at once. The hard part is not the arithmetic — it is being
  // straight about which of these numbers is a fair comparison and which is not.
  const compare = useMemo(() => {
    if (!bothCenters) return null;
    const MIN_STRATUM = 30;   // calls per side before an area code can be compared
    const MIN_MED_N   = 6;    // numbers before an in-area median means anything

    const side = {};
    for (const k of ['South', 'North']) {
      const rows = enrichedAll.filter(d => d.center === k && !replacedSet.has(normPh(d.did)));
      const calls = rows.reduce((t, d) => t + (d.calls || 0), 0);
      const ans   = rows.reduce((t, d) => t + (d.answered || 0), 0);
      const dnc   = rows.reduce((t, d) => t + (d.dncCount || 0), 0);
      // Damaged share, measured inside each area code so regional answer-rate
      // differences cancel out — this is the one contact-quality figure that
      // survives the geography problem.
      const byAc = new Map();
      for (const d of rows) {
        if (d.score === null) continue;
        const a = areaCode(d.did);
        if (!byAc.has(a)) byAc.set(a, []);
        byAc.get(a).push(d);
      }
      let damaged = 0, judged = 0;
      for (const ds of byAc.values()) {
        if (ds.length < MIN_MED_N) continue;
        const med = median(ds.map(d => d.cr || 0).sort((x, y) => x - y));
        if (med === null || med <= 0) continue;
        judged += ds.length;
        damaged += ds.filter(d => (d.cr || 0) < med * DEGRADED_FRAC).length;
      }
      side[k] = {
        dids: rows.length, calls, ans, dnc,
        cr: calls ? (ans / calls) * 100 : 0,
        dncPer1k: calls ? (dnc / calls) * 1000 : 0,
        perDid: rows.length ? calls / rows.length : 0,
        damaged, judged,
        damagedPct: judged ? (damaged / judged) * 100 : null,
      };
    }

    // Shared ground: area codes where BOTH centers have enough calls to compare.
    const acMap = new Map();
    for (const k of ['South', 'North']) {
      for (const d of enrichedAll) {
        if (d.center !== k || replacedSet.has(normPh(d.did))) continue;
        const a = areaCode(d.did);
        let e = acMap.get(a);
        if (!e) { e = { code: a, South: { dids: 0, calls: 0, ans: 0 }, North: { dids: 0, calls: 0, ans: 0 } }; acMap.set(a, e); }
        e[k].dids++; e[k].calls += d.calls || 0; e[k].ans += d.answered || 0;
      }
    }
    const strata = [...acMap.values()]
      .filter(e => e.South.calls >= MIN_STRATUM && e.North.calls >= MIN_STRATUM)
      .map(e => {
        const sc = (e.South.ans / e.South.calls) * 100;
        const nc = (e.North.ans / e.North.calls) * 100;
        return { ...e, sCR: sc, nCR: nc, gap: sc - nc, w: e.South.calls + e.North.calls };
      })
      .sort((a, b) => {
        const wt = e => Math.abs(e.gap) * Math.sqrt(Math.min(e.South.calls, e.North.calls));
        return wt(b) - wt(a);
      });

    // Direct standardisation over the shared strata with common weights.
    let wsum = 0, sNum = 0, nNum = 0, sVol = 0, nVol = 0;
    for (const e of strata) {
      wsum += e.w; sNum += e.sCR * e.w; nNum += e.nCR * e.w;
      sVol += e.South.calls; nVol += e.North.calls;
    }
    const stdS = wsum ? sNum / wsum : null;
    const stdN = wsum ? nNum / wsum : null;
    const covS = side.South.calls ? (sVol / side.South.calls) * 100 : 0;
    const covN = side.North.calls ? (nVol / side.North.calls) * 100 : 0;
    // Below a quarter of each side's volume the standardised figure swings with
    // the threshold and should not be quoted as a result.
    const crComparable = Math.min(covS, covN) >= 25;

    // Same-exposure view: contact rate within matched call-volume bands. Controls
    // for how hard numbers are worked; does NOT control for geography.
    const BANDS = [[0, 50], [50, 100], [100, 200], [200, 350], [350, Infinity]];
    const bands = BANDS.map(([lo, hi]) => {
      const cell = k => {
        const rows = enrichedAll.filter(d => d.center === k && !replacedSet.has(normPh(d.did))
                                          && (d.calls || 0) >= lo && (d.calls || 0) < hi);
        const c = rows.reduce((t, d) => t + (d.calls || 0), 0);
        const a = rows.reduce((t, d) => t + (d.answered || 0), 0);
        return { n: rows.length, calls: c, cr: c ? (a / c) * 100 : null };
      };
      return { lb: hi === Infinity ? lo + '+' : lo + '-' + hi, South: cell('South'), North: cell('North') };
    });

    return { side, strata, stdS, stdN, covS, covN, crComparable, bands, MIN_STRATUM };
  }, [enrichedAll, replacedSet, bothCenters]);

  // Area-code board as CSV — for pasting into a purchasing thread or sheet.
  function exportIntelCSV() {
    const head = 'Area code,Location,DIDs,Total calls,Calls per DID,Depth vs pool,Contact rate %,In-area median CR %,Degraded,DNC per 1k,At risk %,Avg score,Ever held,Burned,Burn %,Status,Risk score,Nearest healthy alt,Alt miles,Untried same-metro';
    const q = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const body = intel.areaRows.map(a => [
      a.code, q(a.label), a.dids, a.calls, a.perDid.toFixed(1), a.depth.toFixed(2),
      a.cr.toFixed(2), a.medianCR === null ? '' : a.medianCR.toFixed(2), a.degraded,
      a.dncPer1k.toFixed(2), a.atRiskPct.toFixed(1),
      a.avgScore === null ? '' : a.avgScore.toFixed(1), a.ever, a.burned, a.burnPct.toFixed(1),
      q(a.status.lb), a.status.risk === null ? '' : a.status.risk,
      a.sub && a.sub.proven ? a.sub.proven.r.code : '',
      a.sub && a.sub.proven ? Math.round(a.sub.proven.mi) : '',
      a.sub && a.sub.fresh.length ? q(a.sub.fresh.map(f => f.code).join(' ')) : '',
    ].join(','));
    const csv = [head, ...body].join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'did_area_code_intel_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // The recommendations plus the order plan, ready to paste into an email.
  function copyIntelSummary() {
    const lines = ['DID BUYING INTELLIGENCE — ' + new Date().toLocaleDateString(), ''];
    intel.recs.forEach((r, i) => { lines.push((i + 1) + '. ' + r.t); lines.push('   ' + r.d); lines.push(''); });
    if (intel.orderPlan.length) {
      lines.push('SUGGESTED ORDER (' + intel.order90 + ' numbers over 90 days):');
      intel.orderPlan.slice(0, 15).forEach(r => {
        const alt = r.sub && r.sub.fresh.length ? '  [untried same-metro: ' + r.sub.fresh.map(f => f.code).join('/') + ']'
                  : r.sub && r.sub.proven ? '  [or ' + r.sub.proven.r.code + ', ' + Math.round(r.sub.proven.mi) + ' mi]' : '';
        lines.push('  ' + r.qty + ' × ' + r.code + ' (' + r.label + ')' + alt);
      });
      lines.push('');
    }
    lines.push('Refresh now:   ' + (intel.areaRows.filter(a => a.status.key === 'refresh').map(a => a.code).join(', ') || 'none'));
    lines.push('Cycle faster:  ' + (intel.areaRows.filter(a => a.status.key === 'cycle').map(a => a.code).join(', ') || 'none'));
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setIntelCopied(true); setTimeout(() => setIntelCopied(false), 2500);
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  function toggleSort(col) {
    setSrt(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' });
  }
  function toggleSwap(id) { setDids(p => p.map(d => {
    if (d.id !== id) return d;
    // In Process numbers are locked: already emailed to Convoso, can't be re-flagged.
    if (isSent(d.did)) return d;
    return { ...d, swapped: !d.swapped };
  })); }
  function retire(id)     { if (confirm('Retire this DID from the pool?')) setDids(p => p.filter(d => d.id !== id)); }

  // Queue every At Risk (D/F) number that isn't already sent/in-process in one click.
  function bulkQueueAtRisk() {
    // enriched carries the computed grade; collect IDs of actionable at-risk DIDs
    const ids = new Set(
      enriched
        .filter(d => (d.grade === 'D' || d.grade === 'F') && !d.swapped && !isSent(d.did) && !isReplaced(d.did))
        .map(d => d.id)
    );
    setDids(prev => prev.map(d => ids.has(d.id) ? { ...d, swapped: true } : d));
  }

  function addDid() {
    if (!form.did.trim()) return;
    setDids(p => [...p, {
      id: _nid++,
      did: form.did.replace(/\D/g, ''),
      calls: parseInt(form.calls) || 0,
      cr: parseFloat(form.cr) || 0,
      dncCount: parseInt(form.dncCount) || 0,
      notes: form.notes,
      swapped: false,
    }]);
    setForm({ did: '', calls: '', cr: '', dncCount: '', notes: '' });
    setShowAdd(false);
  }

  // ── CSV import ───────────────────────────────────────────────────────────────
  function processFile(file) {
    if (!file) return;
    setFname(file.name);
    Papa.parse(file, { header: true, skipEmptyLines: true,
      transformHeader: (h, i) => h.trim() === '' ? `__col_${i}__` : h.trim(),
      complete(res) {
        const hdrs = res.meta.fields || [];
        setCsvHdrs(hdrs); setCsvRows(res.data);
        setColMap(autoDetect(hdrs)); setIStep(1);
      }});
  }
  function handleDrop(e) { e.preventDefault(); setDragOver(false); processFile(e.dataTransfer.files[0]); }

  function buildPreview() {
    const rows = csvRows.map(row => {
      const rawDid = colMap.did ? String(row[colMap.did] || '').trim() : '';
      if (!rawDid || rawDid.replace(/\D/g, '').length < 10) return null;
      const calls    = parseInt(row[colMap.calls]) || 0;
      const answered = parseInt(row[colMap.answered]) || 0;
      const cr       = parseFloat(String(row[colMap.cr] || '').replace('%', '')) || 0;
      const dncCount = parseInt(row[colMap.dncCount]) || 0;
      // Primary signal: the row-level "Campaign" field, if the report populates it.
      let campaign = colMap._campaignField ? String(row[colMap._campaignField] || '').trim() : '';
      // Fallback: infer from the per-campaign count columns (count sits in the column
      // just left of each "Campaign 'X'" header, so dataCol was resolved with the shift).
      if (!campaign) {
        const ccols = colMap._campaignCols || [];
        for (const cc of ccols) {
          const dataCol = cc.dataCol || cc; // handle both new {dataCol,label} and legacy string
          const label   = cc.label   || cc;
          const v = parseInt(row[dataCol]) || 0;
          if (v > 0) {
            const m = label.match(/'([^']+)'/);
            campaign = m ? m[1] : label.replace(/^campaign\s*/i, '').trim();
            break;
          }
        }
      }
      const existing = dids.find(d => normPh(d.did) === normPh(rawDid));
      if (!campaign && existing?.campaign) campaign = existing.campaign;
      const nd = { calls: calls || existing?.calls || 0, cr: cr || existing?.cr || 0, dncCount: dncCount !== undefined ? dncCount : (existing?.dncCount || 0) };
      const s = calcScore(nd);
      return { rawDid, calls, answered, cr, dncCount, campaign, isUpdate: !!existing, exId: existing?.id, score: s, grade: getGrade(s) };
    }).filter(Boolean);
    setPreview(rows); setIStep(2);
  }

  function applyImport() {
    let total = 0, carried = 0, sentHits = 0, replacedHits = 0;
    setDids(prev => {
      // Replace mode: the dropped CSV becomes the entire dataset.
      // Preserve swap-queue flags & notes only for DIDs that exist in BOTH the old and new sets.
      const prevByPhone = new Map(prev.map(d => [normPh(d.did), d]));
      const next = [];
      for (const row of preview) {
        const phone = normPh(row.rawDid);
        const carry = prevByPhone.get(phone);
        if (carry) carried++;
        if (isSent(phone)) sentHits++;
        if (isReplaced(phone)) replacedHits++;
        total++;
        next.push({
          id: _nid++,
          did: phone,
          calls: row.calls,
          answered: row.answered,
          cr: row.cr,
          dncCount: row.dncCount,
          campaign: row.campaign || '',
          notes: carry?.notes || '',
          swapped: carry?.swapped || false,
        });
      }
      return next;
    });
    setCampFilter('all');
    setImportedAt({ fname, time: Date.now() });
    setToast({ total, carried, sentHits, replacedHits });
    setImpOpen(false); resetImp();
    setTimeout(() => setToast(null), 9000);
  }

  function resetImp() { setIStep(0); setCsvRows([]); setCsvHdrs([]); setFname(''); setMapAdjust(false); }
  const sampleVal = f => (!colMap[f] || !csvRows.length) ? '—' : String(csvRows[0][colMap[f]] || '').trim().substring(0, 16) || '—';
  const arrow = col => srt.col === col ? (srt.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const upCt  = preview.filter(r => r.isUpdate).length;
  const newCt = preview.filter(r => !r.isUpdate).length;

  // Status tabs count against viewCounts — scoped to the selected campaign so the
  // numbers change to match whatever campaign you're on (global when "All campaigns").
  const TABS = [
    { k: 'all',     l: `All (${viewCounts.total})` },
    { k: 'clean',   l: `Clean (${viewCounts.clean})` },
    { k: 'watch',   l: `Watch (${viewCounts.watch})` },
    { k: 'atrisk',  l: `At Risk/F (${viewCounts.atRisk + viewCounts.flagged})` },
    { k: 'dnc',     l: `DNC Alert (${viewCounts.dncAlert})`, warn: viewCounts.dncAlert > 0 },
    { k: 'swap',    l: `Swap Queue (${viewCounts.swapQ})`, grp: 'flow', lit: viewCounts.swapQ > 0 },
    { k: 'inproc',  l: `In Process (${viewCounts.inProc})`, grp: 'flow', lit: viewCounts.inProc > 0 },
    { k: 'replaced', l: `Replaced (${viewCounts.replaced})`, grp: 'flow', lit: viewCounts.replaced > 0 },
  ];

  // ── Intel panel ──────────────────────────────────────────────────────────────
  function renderIntel() {
    const pct  = v => (v === null || v === undefined || isNaN(v)) ? '—' : v.toFixed(1) + '%';
    const num1 = v => (v === null || v === undefined || isNaN(v)) ? '—' : v.toFixed(1);

    if (!enriched.length) {
      const scopedOut = enrichedAll.length > 0;
      return h('div', { className: 'intel-panel' },
        h('div', { className: 'intel-empty' },
          h('i', { className: 'ti ' + (scopedOut ? 'ti-building-community' : 'ti-chart-histogram') }),
          h('div', { style: { fontWeight: 700, fontSize: 14 } },
            scopedOut ? 'No numbers in the ' + CENTER_LB[activeScope] + ' tiers' : 'No report loaded'),
          h('div', { style: { fontSize: 12, color: '#6b6b66', marginTop: 4 } },
            scopedOut
              ? 'The loaded report has ' + enrichedAll.length.toLocaleString()
                + ' numbers, none of them in this center. Switch the Center selector above.'
              : 'Analytics are computed from the DID pool. Import a Convoso Contact Rate Report from the Pool view first.'),
        ),
      );
    }

    // Compact substitute cell: the whole point of the local-presence model.
    const subCell = a => {
      if (!a.sub) return h('td', { className: 'sub-cell' }, '—');
      if (a.sub.fresh.length) {
        return h('td', { className: 'sub-cell' },
          h('span', { className: 'sub-fresh', title: 'Same metro, not currently in your pool — no burn history' },
            a.sub.fresh.map(f => f.code).join(' / ')),
          h('span', { className: 'sub-x' }, 'untried, same metro'));
      }
      if (a.sub.proven) {
        const mi = a.sub.proven.mi;
        // Local presence degrades with distance, so say how much is being given
        // up rather than presenting every substitute as equivalent.
        const tier = mi <= SAME_CITY_MI ? 'near' : mi <= 75 ? 'mid' : 'far';
        const lbl  = mi < 1 ? 'same metro'
                   : Math.round(mi) + ' mi · ' + (tier === 'near' ? 'same metro'
                                                : tier === 'mid'  ? 'nearby'
                                                : 'weaker presence');
        return h('td', { className: 'sub-cell' },
          h('span', { className: 'sub-proven sub-' + tier, title: a.sub.proven.r.label }, a.sub.proven.r.code),
          h('span', { className: 'sub-x' }, lbl));
      }
      return h('td', { className: 'sub-cell' },
        h('span', { className: 'sub-none' }, 'none'),
        h('span', { className: 'sub-x' }, 'cycle in place'));
    };

    const tabs = [
      { k: 'area',   l: 'Area codes',    i: 'ti-map-pin'    },
      { k: 'burn',   l: 'Burn & order',  i: 'ti-flame'      },
      { k: 'curve',  l: 'Burn curve',    i: 'ti-chart-line' },
      { k: 'camp',   l: 'Campaign load', i: 'ti-folders'    },
    ];
    if (bothCenters) tabs.push({ k: 'vs', l: 'South vs North', i: 'ti-arrows-left-right' });
    tabs.push({ k: 'pivot', l: 'Pivot', i: 'ti-table' });

    return h('div', { className: 'intel-panel' },

      h('div', { className: 'intel-head' },
        h('div', null,
          h('div', { className: 'intel-title' },
            h('i', { className: 'ti ti-chart-histogram' }), 'Analytics',
            (bothCenters || scopeStranded) && h('span', { className: 'scope-tag scope-tag-' + activeScope },
              activeScope === 'all' ? 'All numbers' : CENTER_LB[activeScope] + ' tiers')),
          h('div', { className: 'intel-sub' },
            Math.round(intel.spanDays) + (Math.round(intel.spanDays) === 1 ? ' day' : ' days') + ' of tracking · '
            + intel.stamped + (intel.stamped === 1 ? ' DID' : ' DIDs') + ' stamped · '
            + intel.ledgerN + (intel.ledgerN === 1 ? ' replacement' : ' replacements') + ' on record'),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'intel-act', onClick: copyIntelSummary },
            h('i', { className: 'ti ' + (intelCopied ? 'ti-check' : 'ti-clipboard') }),
            intelCopied ? 'Copied' : 'Copy summary'),
          h('button', { className: 'intel-act', onClick: exportIntelCSV },
            h('i', { className: 'ti ti-download' }), 'Export CSV'),
        ),
      ),

      // The two premises the whole view rests on, stated once so nobody has to infer them.
      h('div', { className: 'intel-premise' },
        h('i', { className: 'ti ti-map-2' }),
        h('div', null,
          h('b', null, 'Built for local presence. '),
          'Area codes are treated as fixed by the lead, not as things to shop around — so numbers are judged against '
          + 'the other numbers in their own area code rather than against the pool, and any substitute suggested is '
          + 'one that still reaches the same person (same metro first, never past ' + LOCAL_MI + ' miles).'),
      ),

      bothCenters && !scopeStranded && h('div', { className: 'intel-premise scope-premise scope-premise-' + activeScope },
        h('i', { className: 'ti ti-building-community' }),
        h('div', null,
          activeScope === 'all'
            ? [h('b', { key: 'b' }, 'Both centers combined. '),
               'Northern and Southern tiers are run by two different call centers with separate DID pools, '
               + 'and both use this dashboard. Every figure below is a blend of both operations — the burn rate, '
               + 'the forecast and the order quantity describe neither one on its own. Pick a single center '
               + 'before acting on any of it.']
            : [h('b', { key: 'b' }, CENTER_LB[activeScope] + ' tiers only'
                 + (ownLabel(activeScope) === 'your center' ? ' — your center. ' : '. ')),
               'Showing ' + centerCounts[activeScope].toLocaleString() + ' of '
               + (centerCounts.South + centerCounts.North + centerCounts.Other).toLocaleString()
               + ' numbers. The ' + (activeScope === 'South' ? 'Northern' : 'Southern')
               + ' center’s ' + centerCounts[activeScope === 'South' ? 'North' : 'South'].toLocaleString()
               + ' numbers are excluded from every figure below, including the burn rate and the order plan.']),
      ),

      intel.recs.length > 0 && h('div', { className: 'intel-recs' },
        ...intel.recs.map((r, i) => h('div', { key: i, className: 'intel-rec rec-' + r.tone },
          h('div', { className: 'rec-t' }, ...(() => {
            // Plain-title recs render as before. Recs that name area codes get an
            // expandable pill list, because a headline that ends in "+12 more"
            // is hiding exactly the thing you need to act on.
            if (!r.codes || !r.codes.length) return [r.t];
            const open   = !!recOpen[r.key];
            const list   = open ? r.codes : r.codes.slice(0, r.shown);
            const hidden = r.codes.length - list.length;
            return [
              r.pre,
              ...list.map(c => h('span', {
                key: c.code,
                className: 'rec-code',
                title: c.label ? c.code + ' — ' + c.label : c.code,
              }, c.code)),
              (hidden > 0 || open) && h('button', {
                key: '_t',
                className: 'rec-more',
                onClick: () => setRecOpen(p => ({ ...p, [r.key]: !open })),
                title: open
                  ? 'Collapse back to the first ' + r.shown
                  : 'Show all ' + r.codes.length + ' area codes',
              },
                h('i', { className: 'ti ' + (open ? 'ti-chevron-up' : 'ti-chevron-down') }),
                open ? 'show fewer' : '+' + hidden + ' more'),
              r.post || '',
            ];
          })()),
          h('div', { className: 'rec-d' }, r.d),
        )),
      ),

      h('div', { className: 'intel-tabs' },
        ...tabs.map(t => h('button', {
          key: t.k,
          className: 'intel-tab' + (intelTab === t.k ? ' active' : ''),
          onClick: () => setIntelTab(t.k),
        }, h('i', { className: 'ti ' + t.i }), t.l)),
      ),

      // ── Area-code board ──
      intelTab === 'area' && h('div', { className: 'intel-card' },
        h('div', { className: 'intel-card-h' }, 'Area-code health & action'),
        h('div', { className: 'intel-note' },
          h('b', null, 'Damaged'),
          ' counts numbers whose contact rate has fallen below 60% of the median for their OWN area code — '
          + 'that comparison cancels out regional answer-rate differences, so what is left is carrier damage rather than geography. '
          + 'It needs at least ' + MIN_MEDIAN_N + ' scorable numbers in the area code to mean anything and is skipped below that. ',
          h('b', null, 'Depth'),
          ' is calls per number against the ' + intel.base.perDid.toFixed(0)
          + '-call pool average; high depth means too few numbers carrying too much volume in a market you cannot move away from. ',
          h('b', null, 'Status'),
          ' is a 0–14 composite of damage, DNC pressure (pool average ' + intel.base.dnc1k.toFixed(1)
          + ' per 1k), grade mix, and burn history. Contact rate is deliberately NOT scored against the pool. '
          + 'Area codes under ' + MIN_AC_DIDS + ' DIDs or ' + MIN_AC_CALLS + ' calls are held back as low data.'),
        sortBar(acSort, AC_COLS,
          k => cycleSort(setAcSort, AC_COLS, k),
          () => setAcSort([]),
          'Clear — back to risk order'),
        h('div', { className: 'intel-scroll' },
          h('table', { className: 'intel-table' },
            h('thead', null, h('tr', null,
              ...sortHead(AC_COLS, acSort, k => cycleSort(setAcSort, AC_COLS, k)),
            )),
            h('tbody', null, ...(() => {
              const visible = intel.areaRows.filter(a => showLowData || a.status.key !== 'low');
              // No stack = leave the precomputed risk ordering exactly as it was.
              return acSort.length
                ? visible.slice().sort(stackCmp(acSort, AC_COLS, (p, q) => q.dids - p.dids))
                : visible;
            })().map(a => {
              const vs = STATUS_STYLE[a.status.key];
              return h('tr', { key: a.code },
                h('td', { className: 'ac-code' }, a.code),
                h('td', { className: 'ac-loc' }, a.label),
                h('td', null, a.dids),
                h('td', null, a.perDid.toFixed(0)),
                h('td', { className: a.depth >= 1.6 ? 'cell-bad' : a.depth >= 1.4 ? 'cell-warn' : '' },
                  a.depth ? a.depth.toFixed(2) + '×' : '—'),
                h('td', { title: a.medianCR === null ? '' : 'In-area median ' + a.medianCR.toFixed(1) + '%' },
                  pct(a.cr)),
                h('td', { className: a.degradedPct >= 30 ? 'cell-bad' : a.degradedPct >= 18 ? 'cell-warn' : '' },
                  a.medianN >= MIN_MEDIAN_N
                    ? (a.degraded ? a.degraded + ' / ' + a.medianN + '  (' + a.degradedPct.toFixed(0) + '%)' : '0')
                    : h('span', { className: 'na', title: 'Needs ' + MIN_MEDIAN_N + ' scorable numbers in the area code' }, 'n/a')),
                h('td', { className: a.dncPer1k >= 15 ? 'cell-bad' : a.dncPer1k >= 8 ? 'cell-warn' : '' }, num1(a.dncPer1k)),
                h('td', { title: a.burned + ' of ' + a.ever + ' numbers ever held here' },
                  a.burned ? a.burned + ' / ' + a.ever + '  (' + a.burnPct.toFixed(0) + '%)' : '—'),
                subCell(a),
                h('td', null, h('span', {
                  className: 'verdict-pill',
                  title: a.status.risk === null ? 'Not enough sample to judge' : 'Composite risk ' + a.status.risk + ' of 14',
                  style: { background: vs.bg, color: vs.tx, borderColor: vs.br },
                }, a.status.lb)),
              );
            })),
          ),
        ),
        (() => {
          const lowN = intel.areaRows.filter(a => a.status.key === 'low').length;
          if (!lowN) return null;
          return h('button', {
            className: 'intel-more',
            onClick: () => setShowLowData(v => !v),
          }, h('i', { className: 'ti ' + (showLowData ? 'ti-chevron-up' : 'ti-chevron-down') }),
             showLowData
               ? 'Hide ' + lowN + ' low-data area codes'
               : 'Show ' + lowN + ' low-data area codes (under ' + MIN_AC_DIDS + ' DIDs or ' + MIN_AC_CALLS + ' calls)');
        })(),
      ),

      // ── Burn & order ──
      intelTab === 'burn' && h('div', null,
        h('div', { className: 'intel-stats' },
          h('div', { className: 'istat' },
            h('span', { className: 'istat-n' }, intel.perWeek.toFixed(1)),
            h('span', { className: 'istat-l' }, 'Replacements / week'),
            h('span', { className: 'istat-x' }, 'measured over ' + Math.round(Math.min(90, intel.spanDays)) + 'd')),
          h('div', { className: 'istat' + (intel.backlog > 0 ? ' istat-bad' : '') },
            h('span', { className: 'istat-n' }, intel.backlog),
            h('span', { className: 'istat-l' }, 'At risk now'),
            h('span', { className: 'istat-x' }, 'D/F, not yet queued')),
          h('div', { className: 'istat' },
            h('span', { className: 'istat-n' }, intel.inProcN),
            h('span', { className: 'istat-l' }, 'In process'),
            h('span', { className: 'istat-x' }, 'awaiting Convoso')),
          h('div', { className: 'istat' },
            h('span', { className: 'istat-n' }, intel.medTurn === null ? '—' : intel.medTurn.toFixed(0) + 'd'),
            h('span', { className: 'istat-l' }, 'Median turnaround'),
            h('span', { className: 'istat-x' }, intel.medTurn === null ? 'needs a completed swap' : 'sent → replaced')),
        ),

        h('div', { className: 'intel-card' },
          h('div', { className: 'intel-card-h' }, 'Replacement forecast'),
          intel.ledgerN === 0 && h('div', { className: 'ledger-warn' },
            h('i', { className: 'ti ti-alert-triangle' }),
            h('div', null,
              h('b', null, activeScope === 'all'
                ? 'No replacement history in this browser. '
                : 'No replacement history in this browser for the ' + CENTER_LB[activeScope] + ' tiers. '),
              'Sent/replaced tracking is stored per browser, not shared between people — so a center’s history '
              + 'lives on the machine of whoever queues its replacements. An empty forecast here means no history '
              + 'was recorded on THIS machine, not that nothing is burning.'),
          ),
          h('div', { className: 'intel-note' },
            'Forecast = the numbers already at risk today, plus the measured rate at which healthy numbers turn bad, projected forward. '
            + (intel.mature
                ? 'Based on ' + Math.round(intel.spanDays) + ' days of tracking.'
                : 'EARLY ESTIMATE — only ' + Math.round(intel.spanDays) + ' days of tracking and '
                  + intel.ledgerN + ' logged replacements so far. Accuracy improves substantially past 30 days.')),
          h('div', { className: 'fc-row' },
            h('div', { className: 'fc-cell' },
              h('div', { className: 'fc-n' }, intel.f30), h('div', { className: 'fc-l' }, 'next 30 days')),
            h('div', { className: 'fc-cell' },
              h('div', { className: 'fc-n' }, intel.f60), h('div', { className: 'fc-l' }, 'next 60 days')),
            h('div', { className: 'fc-cell' },
              h('div', { className: 'fc-n' }, intel.f90), h('div', { className: 'fc-l' }, 'next 90 days')),
            h('div', { className: 'fc-cell fc-order' },
              h('div', { className: 'fc-n' }, intel.order90), h('div', { className: 'fc-l' }, 'order qty (90d + 20%)')),
          ),
          h('div', { className: 'intel-note', style: { marginTop: 10, marginBottom: 0 } },
            'Recent burn: ' + intel.burn30 + ' queued in the last 30 days, ' + intel.burn60 + ' in 60, ' + intel.burn90 + ' in 90.'),
        ),

        // The purchase order — the thing local presence actually makes actionable.
        intel.orderPlan.length > 0 && h('div', { className: 'intel-card' },
          h('div', { className: 'intel-card-h' }, 'Where those ' + intel.orderPlanned + ' numbers should go'),
          h('div', { className: 'intel-note' },
            'An ALLOCATION of the forecast across area codes by current risk weight (numbers at risk + damaged, '
            + 'plus half-weight on historical burn) — not a per-area-code measurement. There is nowhere near enough '
            + 'history per area code to forecast each one independently, and putting false precision on a purchase '
            + 'order would be worse than none. Where an untried same-metro overlay exists it is listed, because a '
            + 'number in an area code you have never used carries no accumulated carrier reputation at all.'),
          h('div', { className: 'intel-scroll' },
            h('table', { className: 'intel-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'Area'), h('th', null, 'Location'), h('th', null, 'Qty'),
                h('th', null, 'At risk'), h('th', null, 'Damaged'), h('th', null, 'Burned'),
                h('th', null, 'Better local option'),
              )),
              h('tbody', null,
                ...intel.orderPlan.slice(0, 25).map(r => h('tr', { key: r.code },
                  h('td', { className: 'ac-code' }, r.code),
                  h('td', { className: 'ac-loc' }, r.label),
                  h('td', { className: 'qty-cell' }, r.qty),
                  h('td', null, r.atRisk || '—'),
                  h('td', null, r.degraded || '—'),
                  h('td', null, r.burned || '—'),
                  subCell(r),
                )),
                // The table caps at 25 rows; the remainder is stated rather than
                // dropped, so the Qty column always reconciles with the heading.
                intel.orderPlan.length > 25 && (() => {
                  const rest = intel.orderPlan.slice(25);
                  const restQty = rest.reduce((t, r) => t + r.qty, 0);
                  return h('tr', { className: 'order-rest' },
                    h('td', null, '+' + rest.length),
                    h('td', { className: 'ac-loc' }, 'more area codes, 1 each'),
                    h('td', { className: 'qty-cell' }, restQty),
                    h('td', { colSpan: 4, className: 'ac-loc' },
                      rest.slice(0, 30).map(r => r.code).join(', ') + (rest.length > 30 ? ' …' : '')),
                  );
                })(),
              ),
            ),
          ),
        ),

        h('div', { className: 'intel-card' },
          h('div', { className: 'intel-card-h' }, 'DID lifespan'),
          intel.medLife !== null
            ? h('div', null,
                h('div', { className: 'life-n' }, intel.medLife.toFixed(0), h('span', null, ' days')),
                h('div', { className: 'intel-note', style: { marginBottom: 0 } },
                  'Median time from first observation to being queued for replacement, across '
                  + intel.lifespanN + ' numbers. Order new numbers at least this far ahead of when you will need them.'))
            : h('div', { className: 'life-pending' },
                h('i', { className: 'ti ti-hourglass-high' }),
                h('div', null,
                  h('div', { style: { fontWeight: 700, fontSize: 13 } }, 'Collecting — not measurable yet'),
                  h('div', { className: 'intel-note', style: { marginBottom: 0, marginTop: 3 } },
                    'Lifespan needs numbers that were first seen by this dashboard AND later burned. '
                    + intel.stamped + ' DIDs are now stamped with a first-seen date and '
                    + intel.lifespanN + ' of 5 required have completed the cycle. '
                    + 'Tracking began ' + new Date(intel.earliest).toLocaleDateString()
                    + '. Numbers imported before then have no true age on record, so nothing here is back-filled with a guess.')),
              ),
        ),
      ),

      // ── Volume burn curve ──
      intelTab === 'curve' && h('div', { className: 'intel-card' },
        h('div', { className: 'intel-card-h' }, 'Contact rate by call volume'),
        h('div', { className: 'intel-note' },
          'How contact rate holds up as a number accumulates calls. This compares low-volume numbers against '
          + 'high-volume ones in the same report, so age and volume are confounded — but it is the degradation signal '
          + 'available today, and it answers the one question local presence cannot take away from you: at what volume '
          + 'should a number be rotated out? Pool average is ' + intel.poolCR.toFixed(1) + '%.'),
        h('div', { className: 'curve' },
          ...intel.curve.map(c => {
            const maxCR = Math.max(...intel.curve.map(x => x.cr || 0), 1);
            const hpx = c.cr === null ? 0 : Math.max(3, (c.cr / maxCR) * 130);
            const below = c.cr !== null && c.cr < intel.poolCR * 0.85;
            return h('div', { key: c.lb, className: 'curve-col' },
              h('div', { className: 'curve-v' }, c.cr === null ? '—' : c.cr.toFixed(1) + '%'),
              h('div', { className: 'curve-bar-wrap' },
                h('div', {
                  className: 'curve-bar' + (below ? ' curve-bad' : ''),
                  style: { height: hpx + 'px' },
                  title: c.n + ' DIDs · ' + (c.atRiskPct === null ? '—' : c.atRiskPct.toFixed(0) + '% at risk'),
                })),
              h('div', { className: 'curve-lb' }, c.lb),
              h('div', { className: 'curve-n' }, c.n + ' DIDs'),
              h('div', { className: 'curve-n' }, c.atRiskPct === null ? '' : c.atRiskPct.toFixed(0) + '% risk'),
            );
          }),
        ),
        intel.rotateAt
          ? h('div', { className: 'curve-call' },
              h('i', { className: 'ti ti-alert-triangle' }),
              'Contact rate breaks 15% below the pool average in the ' + intel.rotateAt
              + ' call band — treat that as the rotation threshold. Sample: '
              + intel.rotateN + ' of ' + intel.scorableN + ' scorable numbers.')
          : h('div', { className: 'intel-note', style: { marginBottom: 0 } },
              'No volume band has fallen 15% below the pool average yet. No volume-based rotation threshold is warranted from this report.'),
      ),

      // ── Pivot ──
      intelTab === 'pivot' && (() => {
        const m = PIVOT_METRICS.find(x => x.k === pvMetric) || PIVOT_METRICS[0];
        const thin = cell => (cell ? cell.calls : 0) < pvMin;
        // Colour scale across the whole grid so cells are comparable at a glance.
        const vals = [];
        for (const r of pivot.rows) {
          if (pivot.colDim) { for (const c of pivot.cols) { const q = r.cells.get(c); if (q && !thin(q)) { const v = m.agg(q); if (v !== null) vals.push(v); } } }
          else if (!thin(r.total)) { const v = m.agg(r.total); if (v !== null) vals.push(v); }
        }
        const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
        const shade = v => {
          if (v === null || hi === lo) return {};
          let t = (v - lo) / (hi - lo);
          if (m.betterLow) t = 1 - t;
          const g = Math.round(232 - t * 44), r2 = Math.round(252 - t * 60), b = Math.round(238 - t * 40);
          return { background: 'rgb(' + r2 + ',' + g + ',' + b + ')' };
        };
        const sorted = (() => {
          const rs = pivot.rows.slice();
          if (pivot.colDim) return rs.sort((a, b) => pivot.rowDim.ord
            ? a.key.localeCompare(b.key)
            : b.total.calls - a.total.calls);
          const mm = PIVOT_METRICS.find(x => x.k === pvSort.col) || PIVOT_METRICS[0];
          return rs.sort((a, b) => {
            const av = mm.agg(a.total), bv = mm.agg(b.total);
            if (av === null) return 1;
            if (bv === null) return -1;
            return pvSort.dir === 'asc' ? av - bv : bv - av;
          });
        })();

        return h('div', { className: 'intel-card' },
          h('div', { className: 'intel-card-h' }, 'Pivot — slice DID health any way you need'),
          h('div', { className: 'pv-controls' },
            h('label', null, 'Rows',
              h('select', { value: pvRow, onChange: e => setPvRow(e.target.value) },
                ...PIVOT_DIMS.map(d => h('option', { key: d.k, value: d.k }, d.l)))),
            h('label', null, 'Columns',
              h('select', { value: pvCol, onChange: e => setPvCol(e.target.value) },
                h('option', { value: '' }, '— none (show all metrics) —'),
                ...PIVOT_DIMS.filter(d => d.k !== pvRow).map(d => h('option', { key: d.k, value: d.k }, d.l)))),
            pvCol && h('label', null, 'Metric',
              h('select', { value: pvMetric, onChange: e => setPvMetric(e.target.value) },
                ...PIVOT_METRICS.map(x => h('option', { key: x.k, value: x.k }, x.l)))),
            h('label', null, 'Mark thin under',
              h('select', { value: String(pvMin), onChange: e => setPvMin(parseInt(e.target.value)) },
                ...[0, 25, 50, 100, 250, 500].map(v => h('option', { key: v, value: String(v) },
                  v === 0 ? 'no marking' : v + ' calls')))),
            h('button', { className: 'intel-act', onClick: exportPivotCSV },
              h('i', { className: 'ti ti-download' }), 'Export'),
          ),
          h('div', { className: 'intel-note' },
            pivot.colDim
              ? 'Each cell is ' + m.l.toLowerCase() + ' for that ' + pivot.rowDim.l.toLowerCase() + ' × '
                + pivot.colDim.l.toLowerCase() + ' combination, shaded best-to-worst across the whole grid. '
              : 'One row per ' + pivot.rowDim.l.toLowerCase() + ', every metric side by side. Click a column heading to sort. ',
            'Cells under ' + pvMin + ' calls are dimmed — at that sample a contact rate swings on a handful of answers. '
            + 'Everything here respects the center selector and excludes replaced numbers.'),
          pivot.excluded.length > 0 && h('div', { className: 'pv-foot' },
            h('b', null, '* '),
            pivot.excluded.length === 1 ? 'Canadian province ' : 'Canadian provinces ',
            pivot.excluded.join(', '),
            ' — listed above but held out of the total row.',
            pivot.unmappedInTotal
              ? ' “Unmapped” is area codes missing from the geography table; they stay in the total because they are real numbers, but they are not confirmed US.'
              : ''),
          h('div', { className: 'intel-scroll' },
            h('table', { className: 'intel-table pv-table' },
              h('thead', null, h('tr', null,
                h('th', null, pivot.rowDim.l),
                ...(pivot.colDim
                  ? [...pivot.cols.map(c => h('th', { key: c }, c)), h('th', { key: '_t' }, 'Total')]
                  : PIVOT_METRICS.map(x => h('th', {
                      key: x.k,
                      className: 'pv-sortable' + (pvSort.col === x.k ? ' pv-sorted' : ''),
                      onClick: () => setPvSort(p => ({ col: x.k, dir: p.col === x.k && p.dir === 'desc' ? 'asc' : 'desc' })),
                      title: 'Sort by ' + x.l,
                    }, x.short, pvSort.col === x.k ? (pvSort.dir === 'desc' ? ' ▾' : ' ▴') : ''))),
              )),
              h('tbody', null,
                ...sorted.map(r => h('tr', { key: r.key },
                  h('td', { className: 'pv-rowlbl' }, pivot.rowDim.lab ? pivot.rowDim.lab(r.key) : r.key),
                  ...(pivot.colDim
                    ? [...pivot.cols.map(c => {
                        const cell = r.cells.get(c);
                        const v = cell ? m.agg(cell) : null;
                        const th = !cell || thin(cell);
                        return h('td', {
                          key: c,
                          className: th ? 'pv-thin' : '',
                          style: th ? {} : shade(v),
                          title: cell ? cell.dids + ' numbers · ' + cell.calls.toLocaleString() + ' calls' : 'no numbers',
                        }, v === null ? '·' : m.fmt(v));
                      }),
                      h('td', { key: '_t', className: 'pv-total' }, (() => {
                        const v = m.agg(r.total); return v === null ? '—' : m.fmt(v);
                      })())]
                    : PIVOT_METRICS.map(x => {
                        const v = x.agg(r.total);
                        const th = thin(r.total) && (x.k === 'cr' || x.k === 'dnc1k' || x.k === 'atRisk');
                        return h('td', { key: x.k, className: th ? 'pv-thin' : '' },
                          v === null ? '—' : x.fmt(v));
                      })),
                )),
                h('tr', { className: 'pv-grand' },
                  h('td', null, 'All ' + pivot.totalRows + ' ' + (pivot.rowDim.plural || pivot.rowDim.l.toLowerCase())
                    + (pivot.unmappedInTotal ? ' + unmapped' : '')),
                  ...(pivot.colDim
                    ? [...pivot.cols.map(c => {
                        const ct = pivot.colTotals.get(c);
                        const v = ct ? m.agg(ct) : null;
                        return h('td', { key: c }, v === null ? '—' : m.fmt(v));
                      }), h('td', { key: '_t' }, (() => { const v = m.agg(pivot.grand); return v === null ? '—' : m.fmt(v); })())]
                    : PIVOT_METRICS.map(x => {
                        const v = x.agg(pivot.grand);
                        return h('td', { key: x.k }, v === null ? '—' : x.fmt(v));
                      })),
                ),
              ),
            ),
          ),
        );
      })(),

      // ── Head-to-head ──
      intelTab === 'vs' && compare && (() => {
        const S = compare.side.South, N = compare.side.North;
        const gap = (a, b) => (a === null || b === null) ? null : a - b;
        // Shared-ground rows. The sort has to run BEFORE the 30-row cap, or the
        // cap would freeze the default top 30 and sorting would only shuffle
        // those — the row you were looking for would never appear.
        const VS_CAP = 30;
        const vsPool = compare.strata.filter(e => showThinVs || Math.min(e.South.calls, e.North.calls) >= 100);
        const vsOrdered = vsSort.length
          ? vsPool.slice().sort(stackCmp(vsSort, VS_COLS,
              (p, q) => (q.South.calls + q.North.calls) - (p.South.calls + p.North.calls)))
          : vsPool;
        const vsRows = vsOrdered.slice(0, VS_CAP);
        const vsHidden = vsOrdered.length - vsRows.length;
        // A comparison row: value per side, plus who it favours and by how much.
        const cmpRow = (label, sv, nv, fmt, betterLow, note) => {
          const g = gap(sv, nv);
          const winner = g === null || Math.abs(g) < 1e-9 ? null
                       : (betterLow ? (g < 0 ? 'South' : 'North') : (g > 0 ? 'South' : 'North'));
          return h('tr', { key: label },
            h('td', { className: 'vs-metric' }, label,
              note && h('span', { className: 'vs-note' }, note)),
            h('td', { className: 'vs-val' + (winner === 'South' ? ' vs-win' : '') }, sv === null ? '—' : fmt(sv)),
            h('td', { className: 'vs-val' + (winner === 'North' ? ' vs-win' : '') }, nv === null ? '—' : fmt(nv)),
            h('td', { className: 'vs-gap' },
              g === null ? '—' : h('span', { className: 'vs-pill vs-pill-' + (winner || 'tie') },
                winner ? winner + ' by ' + fmt(Math.abs(g)) : 'level')),
          );
        };
        const p1 = v => v.toFixed(1) + '%';
        const p2 = v => v.toFixed(2);
        const n0 = v => Math.round(v).toLocaleString();

        return h('div', null,
          h('div', { className: 'intel-card' },
            h('div', { className: 'intel-card-h' }, 'Headline — reported side by side, not ranked'),
            h('div', { className: 'vs-head' },
              h('div', { className: 'vs-side vs-side-South' },
                h('div', { className: 'vs-side-l' }, 'Southern tiers'),
                h('div', { className: 'vs-side-n' }, S.cr.toFixed(2) + '%'),
                h('div', { className: 'vs-side-x' }, S.dids.toLocaleString() + ' numbers · ' + S.calls.toLocaleString() + ' calls')),
              h('div', { className: 'vs-mid' }, 'contact rate'),
              h('div', { className: 'vs-side vs-side-North' },
                h('div', { className: 'vs-side-l' }, 'Northern tiers'),
                h('div', { className: 'vs-side-n' }, N.cr.toFixed(2) + '%'),
                h('div', { className: 'vs-side-x' }, N.dids.toLocaleString() + ' numbers · ' + N.calls.toLocaleString() + ' calls')),
            ),
            h('div', { className: 'intel-note', style: { marginTop: 11, marginBottom: 0 } },
              'Adjusted for area-code mix across the ' + compare.strata.length + ' area codes with at least '
              + compare.MIN_STRATUM + ' calls on both sides: Southern '
              + (compare.stdS === null ? '—' : compare.stdS.toFixed(2) + '%') + ', Northern '
              + (compare.stdN === null ? '—' : compare.stdN.toFixed(2) + '%') + '. '
              + (compare.crComparable
                  ? 'Coverage is wide enough to take this seriously.'
                  : 'Shown for completeness only — at this coverage it is not a usable result.')),
          ),

          h('div', { className: 'intel-card' },
            h('div', { className: 'intel-card-h' }, 'What can be compared fairly'),
            h('div', { className: 'intel-note' },
              'Each of these either cancels the regional baseline out by construction, or has nothing to do with '
              + 'geography in the first place.'),
            h('table', { className: 'intel-table vs-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'Metric'), h('th', null, 'Southern'), h('th', null, 'Northern'), h('th', null, 'Gap'))),
              h('tbody', null,
                cmpRow('Damaged numbers', S.damagedPct, N.damagedPct, p1, true,
                  'share sitting below 60% of their OWN area code’s median — region-neutral'),
                cmpRow('Calls per number', S.perDid, N.perDid, v => v.toFixed(1), true,
                  'carrier exposure per number; higher burns numbers faster'),
                cmpRow('DNC per 1,000 calls', S.dncPer1k, N.dncPer1k, p2, true,
                  'a reaction to your number, not a property of the region'),
                cmpRow('Numbers in rotation', S.dids, N.dids, n0, false,
                  'pool size — context, not performance'),
              ),
            ),
            S.damagedPct !== null && N.damagedPct !== null && Math.abs(S.damagedPct - N.damagedPct) >= 3 &&
              h('div', { className: 'vs-callout' },
                h('i', { className: 'ti ti-bulb' }),
                (S.damagedPct > N.damagedPct ? 'Southern' : 'Northern') + ' tiers carry '
                + (Math.max(S.damagedPct, N.damagedPct) / Math.max(0.1, Math.min(S.damagedPct, N.damagedPct))).toFixed(1)
                + '× the share of damaged numbers — ' + S.damagedPct.toFixed(1) + '% vs ' + N.damagedPct.toFixed(1)
                + '%. Because each number is measured against others in its own area code, this gap is real and not '
                + 'a geography artefact. It is the comparison worth acting on, and it points the opposite way from '
                + 'the raw contact rates.'),
          ),

          h('div', { className: 'intel-card' },
            h('div', { className: 'intel-card-h' }, 'Same exposure, side by side'),
            h('div', { className: 'intel-note' },
              'Contact rate within matched call-volume bands. This removes the "one center works its numbers harder" '
              + 'effect, but it does NOT remove geography — read it as texture, not as a verdict.'),
            h('div', { className: 'intel-scroll' },
              h('table', { className: 'intel-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'Call band'), h('th', null, 'S numbers'), h('th', null, 'S contact rate'),
                  h('th', null, 'N numbers'), h('th', null, 'N contact rate'), h('th', null, 'Difference'))),
                h('tbody', null, ...compare.bands.map(b => {
                  const g = (b.South.cr !== null && b.North.cr !== null) ? b.South.cr - b.North.cr : null;
                  const thin = b.South.n < 5 || b.North.n < 5;
                  return h('tr', { key: b.lb },
                    h('td', { className: 'ac-code' }, b.lb),
                    h('td', null, b.South.n),
                    h('td', null, b.South.cr === null ? '—' : b.South.cr.toFixed(1) + '%'),
                    h('td', null, b.North.n),
                    h('td', null, b.North.cr === null ? '—' : b.North.cr.toFixed(1) + '%'),
                    h('td', null, g === null ? '—'
                      : h('span', { className: thin ? 'na' : '' },
                          (g > 0 ? 'S +' : 'S ') + g.toFixed(1) + (thin ? ' (thin)' : ''))));
                })),
              ),
            ),
          ),

          h('div', { className: 'intel-card' },
            h('div', { className: 'intel-card-h' },
              'Shared ground — ' + compare.strata.length + ' area codes you both call into'),
            h('div', { className: 'intel-note' },
              compare.strata.length
                ? 'The only places a direct contact-rate comparison is defensible, because the geography is held '
                  + 'constant. '
                  + (vsSort.length
                      ? 'Sorted by your column stack below — clear it to go back to gap size weighted by the '
                        + 'smaller side’s call volume, which is the order that keeps a real difference measured '
                        + 'over thousands of calls above a wild swing measured over fifty. '
                      : 'Ordered by gap size weighted by the smaller side’s call volume, so a real difference '
                        + 'measured over thousands of calls outranks a wild swing measured over fifty. ')
                  + 'Rows marked THIN have under 100 calls on one side — that gap is within noise, so treat it '
                  + 'as a lead to look into rather than a finding.'
                : 'There are no area codes where both centers have at least ' + compare.MIN_STRATUM
                  + ' calls, so there is no shared ground on which to compare contact rate directly at all.'),
            (() => {
              const solid = compare.strata.filter(e => Math.min(e.South.calls, e.North.calls) >= 100);
              const thin  = compare.strata.length - solid.length;
              if (!compare.strata.length) return null;
              if (!solid.length) return h('div', { className: 'vs-callout' },
                h('i', { className: 'ti ti-alert-triangle' }),
                'None of the ' + compare.strata.length + ' shared area codes has 100+ calls on both sides — the most '
                + 'either center puts through an area code the other also works is too little to compare. There is no '
                + 'defensible head-to-head contact-rate number to be had from this report, at any cut. '
                + 'The region-neutral metrics above are the comparison.');
              return h('div', { className: 'intel-note', style: { marginBottom: 8 } },
                solid.length + ' of ' + compare.strata.length + ' shared area codes carry 100+ calls on both sides. '
                + (thin ? 'The other ' + thin + ' are shown only if you ask — their gaps are within noise.' : ''));
            })(),
            compare.strata.length > 0 && sortBar(vsSort, VS_COLS,
              k => cycleSort(setVsSort, VS_COLS, k),
              () => setVsSort([]),
              'Clear — back to weighted gap order'),
            compare.strata.length > 0 && h('div', { className: 'intel-scroll' },
              h('table', { className: 'intel-table' },
                h('thead', null, h('tr', null,
                  ...sortHead(VS_COLS, vsSort, k => cycleSort(setVsSort, VS_COLS, k)),
                )),
                h('tbody', null, ...vsRows.map(e => h('tr', { key: e.code, className: Math.min(e.South.calls, e.North.calls) < 100 ? 'vs-thin' : '' },
                  h('td', { className: 'ac-code' }, e.code),
                  h('td', { className: 'ac-loc' }, npaLabel(e.code)),
                  h('td', null, e.South.dids), h('td', null, e.South.calls.toLocaleString()),
                  h('td', null, e.sCR.toFixed(1) + '%'),
                  h('td', null, e.North.dids), h('td', null, e.North.calls.toLocaleString()),
                  h('td', null, e.nCR.toFixed(1) + '%'),
                  h('td', null,
                    h('span', { className: 'vs-pill vs-pill-' + (e.gap > 0 ? 'South' : 'North') },
                      (e.gap > 0 ? 'S +' : 'N +') + Math.abs(e.gap).toFixed(1)),
                    Math.min(e.South.calls, e.North.calls) < 100 && h('span', { className: 'vs-thin-tag',
                      title: 'Under 100 calls on one side — the gap is within noise' }, 'thin'))))),
              ),
            ),
            vsHidden > 0 && h('div', { className: 'intel-note', style: { marginTop: 8, marginBottom: 0 } },
              'Showing the top ' + VS_CAP + ' of ' + vsOrdered.length + ' rows'
              + (vsSort.length ? ' under your sort' : ' by weighted gap')
              + ' — ' + vsHidden + ' more are not displayed. Sort by the column you care about to bring '
              + 'different rows into the top ' + VS_CAP + '.'),
            (() => {
              const thin = compare.strata.filter(e => Math.min(e.South.calls, e.North.calls) < 100).length;
              if (!thin) return null;
              return h('button', { className: 'intel-more', onClick: () => setShowThinVs(v => !v) },
                h('i', { className: 'ti ' + (showThinVs ? 'ti-chevron-up' : 'ti-chevron-down') }),
                showThinVs ? 'Hide ' + thin + ' thin-sample area codes'
                           : 'Show ' + thin + ' thin-sample area codes (under 100 calls on one side)');
            })(),
          ),
        );
      })(),

      // ── Campaign load ──
      intelTab === 'camp' && h('div', { className: 'intel-card' },
        h('div', { className: 'intel-card-h' }, 'Campaign exposure — which campaigns burn numbers fastest'),
        h('div', { className: 'intel-note' },
          'Calls per DID is carrier exposure per number. A campaign running well above the pool average of '
          + intel.poolPerDid.toFixed(0) + ' calls/DID will degrade its numbers proportionally faster, '
          + 'so it needs either a wider DID pool or a larger replacement budget.'),
        h('div', { className: 'intel-scroll' },
          h('table', { className: 'intel-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'Campaign'), h('th', null, 'DIDs'), h('th', null, 'Calls'),
              h('th', null, 'Calls / DID'), h('th', null, 'Exposure'), h('th', null, 'Contact rate'),
              h('th', null, 'At risk'), h('th', null, 'Burned'),
            )),
            h('tbody', null, ...(() => {
              const row = c => h('tr', { key: c.name },
                h('td', { className: 'ac-code' }, c.name),
                h('td', null, c.dids),
                h('td', null, c.calls.toLocaleString()),
                h('td', null, c.perDid.toFixed(0)),
                h('td', { className: c.exposure >= 1.5 ? 'cell-bad' : c.exposure >= 1.25 ? 'cell-warn' : '' },
                  c.exposure.toFixed(2) + '×'),
                h('td', { className: c.cr < 15 ? 'cell-bad' : c.cr < 20 ? 'cell-warn' : '' }, pct(c.cr)),
                h('td', { className: c.atRiskPct >= 40 ? 'cell-bad' : c.atRiskPct >= 25 ? 'cell-warn' : '' }, pct(c.atRiskPct)),
                h('td', null, c.burned || '—'),
              );
              // Viewing a single center — no grouping needed.
              if (activeScope !== 'all') return intel.campRows.map(row);
              // Viewing both — separate the two operations rather than
              // interleaving them, and subtotal each so the centers are
              // comparable at a glance.
              const out = [];
              for (const grp of ['South', 'North', 'Other']) {
                const rows = intel.campRows.filter(c => centerOf(c.name) === grp);
                if (!rows.length) continue;
                const dids  = rows.reduce((t, c) => t + c.dids, 0);
                const calls = rows.reduce((t, c) => t + c.calls, 0);
                const ans   = rows.reduce((t, c) => t + c.ans, 0);
                const burn  = rows.reduce((t, c) => t + c.burned, 0);
                out.push(h('tr', { key: 'h-' + grp, className: 'center-head' },
                  h('td', { colSpan: 8 },
                    h('i', { className: 'ti ti-building-community' }),
                    CENTER_LB[grp] + ' tiers',
                    h('span', { className: 'center-head-sub' },
                      grp === 'Other' ? 'no center identified' : (ownLabel(grp) || 'separate operation')))));
                rows.forEach(c => out.push(row(c)));
                out.push(h('tr', { key: 's-' + grp, className: 'center-sub' },
                  h('td', null, CENTER_LB[grp] + ' total'),
                  h('td', null, dids),
                  h('td', null, calls.toLocaleString()),
                  h('td', null, dids ? (calls / dids).toFixed(0) : '—'),
                  h('td', null, '—'),
                  h('td', null, calls ? ((ans / calls) * 100).toFixed(1) + '%' : '—'),
                  h('td', null, '—'),
                  h('td', null, burn || '—')));
              }
              return out;
            })()),
          ),
        ),
      ),
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return h('div', null,

    // Sticky header
    h('div', { className: 'sticky' },
      h('div', { className: 'sticky-row' },
        h('div', { style: { flex: 1 } },
          h('div', { className: 'sticky-sub', style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('img', { src: 'data:image/png;base64,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', alt: 'DID Phone Shield', width: 36, height: 44, style: { flexShrink: 0 } }),
            'Convoso Contact Rate Report',
            h('span', { style: { marginLeft: 4, fontSize: 9, color: '#3d5080', fontWeight: 600 } }, 'v6.22.0')),
          h('div', { className: 'sticky-title' }, 'DID Dashboard'),
        ),
        h('div', { className: 'nav-cluster' + (homeCenter === null ? ' nav-new' : '') },
        (bothCenters || scopeStranded) && h('div', { className: 'scope-switch' },
          h('span', { className: 'scope-lbl' }, 'Center'),
          ...[
            { k: 'South', l: 'South', n: centerCounts.South,
              t: 'Southern tiers' + (ownLabel('South') ? ' — ' + ownLabel('South') : '') },
            { k: 'North', l: 'North', n: centerCounts.North,
              t: 'Northern tiers' + (ownLabel('North') ? ' — ' + ownLabel('North') : '') },
            { k: 'all',   l: 'Both',  n: centerCounts.South + centerCounts.North + centerCounts.Other,
              t: 'Both centers combined — pooled figures describe neither operation on its own' },
          ].map(o => h('button', {
            key: o.k,
            className: 'scope-btn scope-' + o.k + (activeScope === o.k ? ' active' : '')
                       + (o.n === 0 && o.k !== 'all' ? ' scope-empty' : ''),
            onClick: () => setScope(o.k),
            title: o.n === 0 && o.k !== 'all' ? o.t + ' — no numbers in this report' : o.t,
          }, o.l, h('span', { className: 'scope-n' }, o.n.toLocaleString()))),
        ),
        h('div', { className: 'view-switch' },
          h('span', { className: 'scope-lbl' }, 'View'),
          h('button', {
            className: 'view-btn' + (view === 'pool' ? ' active' : ''),
            onClick: () => setView('pool'),
          }, h('i', { className: 'ti ti-list-details' }), 'Pool'),
          h('button', {
            className: 'view-btn' + (view === 'intel' ? ' active' : ''),
            onClick: () => setView('intel'),
          }, h('i', { className: 'ti ti-chart-histogram' }), 'Analytics'),
        ),
        ),
        h('button', { onClick: () => setShowAdd(v => !v), style: { fontSize: 12, padding: '4px 8px' } },
          h('i', { className: 'ti ti-plus', style: { fontSize: 13 } })),
      ),
    ),

    h('div', { className: 'main' + (view === 'intel' ? ' view-intel' : '') },

      // Asked once per browser. Both call centers use this dashboard, so
      // guessing whose numbers to show would be wrong half the time.
      bothCenters && homeCenter === null && h('div', { className: 'center-pick' },
        h('i', { className: 'ti ti-building-community' }),
        h('div', { style: { flex: 1 } },
          h('div', { className: 'center-pick-t' }, 'Which call center do you work?'),
          h('div', { className: 'center-pick-d' },
            'The Northern and Southern tiers are separate operations with separate DID pools, and both use this '
            + 'dashboard. Pooling them gives a burn rate and an order quantity that fit neither. Pick yours and '
            + 'everything — counts, swap queue, forecast, order plan — scopes to it. You can switch any time '
            + 'with the Center control up top; this is only asked once.'),
          h('div', { className: 'center-pick-btns' },
            h('button', { className: 'center-pick-b cp-South', onClick: () => chooseHome('South') },
              'Southern tiers', h('span', null, centerCounts.South.toLocaleString() + ' numbers')),
            h('button', { className: 'center-pick-b cp-North', onClick: () => chooseHome('North') },
              'Northern tiers', h('span', null, centerCounts.North.toLocaleString() + ' numbers')),
            h('button', { className: 'center-pick-b cp-all', onClick: () => chooseHome('all') },
              'I work both', h('span', null, 'no default scope')),
          ),
        ),
      ),

      scopeStranded && h('div', { className: 'scope-strand' },
        h('i', { className: 'ti ti-info-circle' }),
        h('div', null,
          h('b', null, 'Showing all numbers. '),
          'This browser is set to the ' + CENTER_LB[scope] + ' tiers, but this report contains none — it looks like '
          + 'a single-center or single-campaign export. Rather than show you an empty dashboard, everything in the '
          + 'report is displayed. Pick a center above to override.'),
      ),

      view === 'intel' && renderIntel(),

      // ── Pool health bar — OVERALL, always all DIDs (never scoped to a campaign) ──
      enriched.length > 0 && (() => {
        const hc = counts;
        return h('div', { className: 'health-bar' },
          h('div', { className: 'health-item' },
            h('span', { className: 'health-num' }, hc.total),
            h('span', { className: 'health-lbl' }, 'Total DIDs'),
          ),
          h('div', { className: 'health-divider' }),
          h('div', { className: 'health-item health-good' },
            h('span', { className: 'health-num' }, hc.clean),
            h('span', { className: 'health-lbl' }, 'Clean A/B'),
          ),
          h('div', { className: 'health-divider' }),
          h('div', { className: 'health-item' + (hc.atRisk + hc.flagged > 0 ? ' health-bad' : '') },
            h('span', { className: 'health-num' }, hc.atRisk + hc.flagged),
            h('span', { className: 'health-lbl' }, 'At Risk / F'),
          ),
          h('div', { className: 'health-divider' }),
          h('div', { className: 'health-item' + (hc.dncAlert > 0 ? ' health-warn' : '') },
            h('span', { className: 'health-num' }, hc.dncAlert),
            h('span', { className: 'health-lbl' }, 'DNC Alerts'),
          ),
          h('div', { className: 'health-divider' }),
          h('div', { className: 'health-item' + (hc.inProc > 0 ? ' health-proc' : '') },
            h('span', { className: 'health-num' }, hc.inProc),
            h('span', { className: 'health-lbl' }, 'In Process'),
          ),
          h('div', { className: 'health-divider' }),
          h('div', { className: 'health-item' },
            h('span', { className: 'health-num' }, hc.avgCR + '%'),
            h('span', { className: 'health-lbl' }, 'Avg CR'),
          ),
          importedAt && h('div', { className: 'health-import-meta' },
            h('i', { className: 'ti ti-clock', style: { fontSize: 11, marginRight: 3 } }),
            'Loaded ',
            h('span', { title: importedAt.fname }, importedAt.fname.length > 28 ? importedAt.fname.substring(0, 26) + '…' : importedAt.fname),
            (() => {
              const dt = new Date(importedAt.time);
              const sameDay = dt.toDateString() === new Date().toDateString();
              const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return sameDay ? ' at ' + time : ' on ' + dt.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
            })(),
            h('button', {
              onClick: () => {
                if (confirm('Clear the saved DID pool from this browser? Swap flags and notes will be lost. Sent / Replaced tracking is kept.')) {
                  setDids([]); setImportedAt(null); setCampFilter('all'); setFilter('all'); poolStore.clear(); setImpOpen(true);
                }
              },
              title: 'Clear saved data',
              style: { marginLeft: 8, fontSize: 10, padding: '1px 7px', borderRadius: 5, background: 'transparent', color: '#9a9a96', border: '1px solid #d0cfc9', cursor: 'pointer' },
            }, h('i', { className: 'ti ti-trash', style: { fontSize: 10, marginRight: 2 } }), 'Clear'),
          ),
        );
      })(),

      // ── Empty state — shown when no data is loaded ──
      enriched.length === 0 && h('div', { className: 'session-warn' },
        h('i', { className: 'ti ti-file-upload', style: { fontSize: 16, flexShrink: 0, color: '#854F0B' } }),
        h('div', null,
          h('div', { style: { fontWeight: 700, fontSize: 13 } }, 'No report loaded'),
          h('div', { style: { fontSize: 11, marginTop: 2, opacity: 0.85 } },
            'Drop a Convoso Contact Rate Report CSV above to load your DID pool. Data saves in this browser automatically and survives refreshes.'),
        ),
      ),

      // Toast
      toast && h('div', { className: 'toast' + (toast.sentHits > 0 ? ' toast-warn' : '') },
        h('i', { className: 'ti ' + (toast.sentHits > 0 ? 'ti-alert-triangle' : 'ti-check'), style: { fontSize: 14 } }),
        h('div', null,
          h('div', null, `Loaded ${toast.total} DIDs${toast.carried > 0 ? ` · kept ${toast.carried} swap flag${toast.carried === 1 ? '' : 's'}` : ''}`),
          toast.sentHits > 0 && h('div', { style: { fontSize: 11, marginTop: 2, fontWeight: 600 } },
            `\u26a0 ${toast.sentHits} ${toast.sentHits === 1 ? 'is' : 'are'} already sent to Convoso (in process) \u2014 check the "In Process" tab before re-pushing`),
          toast.replacedHits > 0 && h('div', { style: { fontSize: 11, marginTop: 2, fontWeight: 600, color: '#4a2d79' } },
            `\u2713 ${toast.replacedHits} ${toast.replacedHits === 1 ? 'was' : 'were'} already replaced \u2014 see the "Replaced" tab`),
        ),
        h('button', { onClick: () => setToast(null) }, '×'),
      ),

      // Import panel
      h('div', { className: 'panel', style: { border: '1px solid #639922' } },
        h('button', {
          className: 'panel-trigger',
          onClick: () => { setImpOpen(v => !v); if (impOpen) resetImp(); },
          style: { background: '#EAF3DE' },
        },
          h('i', { className: 'ti ti-file-upload', style: { fontSize: 15, color: '#27500A' } }),
          h('span', { style: { fontSize: 12, fontWeight: 600, color: '#27500A' } }, 'Load new Convoso report'),
          h('span', { style: { fontSize: 11, color: '#4f7a2e', marginLeft: 2 } }, '— drop updated CSV to refresh scores'),
          h('i', { className: `ti ${impOpen ? 'ti-chevron-up' : 'ti-chevron-down'}`, style: { marginLeft: 'auto', fontSize: 13, color: '#639922' } }),
        ),

        impOpen && h('div', { className: 'panel-body' },

          // Step indicators
          h('div', { className: 'steps' },
            ...[['1','Upload'],['2','Map'],['3','Apply']].map(([n, lbl], i) => [
              h('div', { key: n, style: { display: 'flex', alignItems: 'center', gap: 3 } },
                h('div', {
                  className: 'step-num',
                  style: { background: iStep >= i ? '#378ADD' : '#f0eeea', color: iStep >= i ? '#fff' : '#9a9a96', border: `1px solid ${iStep >= i ? '#378ADD' : '#d0cfc9'}` },
                }, n),
                h('span', { className: 'step-lbl', style: { color: iStep === i ? '#1c1c1a' : '#9a9a96', fontWeight: iStep === i ? 500 : 400 } }, lbl),
              ),
              i < 2 && h('div', { key: 'l' + i, className: 'step-line' }),
            ]).flat()
          ),

          // Step 0: drop zone
          iStep === 0 && h('div', null,
            h('div', {
              className: `drop-zone${isDragOver ? ' over' : ''}`,
              onDragOver: e => { e.preventDefault(); setDragOver(true); },
              onDragLeave: () => setDragOver(false),
              onDrop: handleDrop,
              onClick: () => fileRef.current && fileRef.current.click(),
            },
              h('i', { className: 'ti ti-file-spreadsheet' }),
              h('p', { style: { fontWeight: 500, fontSize: 13, marginBottom: 4 } }, 'Drop Convoso Contact Rate Report'),
              h('p', { style: { fontSize: 11, color: '#6b6b68', marginBottom: 12 } }, 'Auto-maps DID, Calls, Contacts %, DNC columns'),
              h('span', { className: 'badge', style: { background: '#f0eeea', color: '#1c1c1a', border: '1px solid #d0cfc9', cursor: 'pointer' } }, 'Browse files'),
            ),
            h('input', { ref: fileRef, type: 'file', accept: '.csv,.txt', style: { display: 'none' }, onChange: e => processFile(e.target.files[0]) }),
            h('button', { className: 'dl-link', onClick: downloadTemplate },
              h('i', { className: 'ti ti-download', style: { fontSize: 13 } }), 'Download CSV template'),
          ),

          // Step 1: map columns
          iStep === 1 && h('div', null,
            h('div', { className: 'info-row' },
              h('i', { className: 'ti ti-file-text', style: { fontSize: 14, color: '#6b6b68' } }),
              h('span', { style: { fontWeight: 500 } }, fname),
              h('span', { style: { color: '#6b6b68' } }, `${csvRows.length.toLocaleString()} rows`),
              h('button', { onClick: resetImp, style: { marginLeft: 'auto', fontSize: 11, padding: '3px 8px' } },
                h('i', { className: 'ti ti-x', style: { fontSize: 11 } }), 'Reset'),
            ),
            (() => {
              const missingReq = MAP_FIELDS.filter(({ f, req }) => req && !colMap[f]);
              const allReqMapped = missingReq.length === 0;
              return [
                !mapAdjust && allReqMapped && h('div', { key: 'confirm', className: 'map-confirm' },
                  ...MAP_FIELDS.filter(({ f }) => colMap[f]).map(({ f, lb }) => h('div', { key: f, className: 'map-confirm-row' },
                    h('span', { className: 'map-confirm-field' }, lb),
                    h('i', { className: 'ti ti-arrow-right', style: { fontSize: 12, color: '#9a9a96' } }),
                    h('span', { className: 'map-confirm-col' }, colMap[f]),
                  )),
                  h('button', { className: 'dl-link', onClick: () => setMapAdjust(true), style: { marginTop: 6 } },
                    h('i', { className: 'ti ti-adjustments', style: { fontSize: 13 } }), 'Adjust mapping'),
                ),
                !mapAdjust && !allReqMapped && h('div', { key: 'warn', className: 'map-fail' },
                  h('div', { className: 'map-fail-hd' },
                    h('i', { className: 'ti ti-alert-triangle', style: { fontSize: 15 } }),
                    h('span', null, `Couldn't match ${missingReq.length === 1 ? 'a required column' : 'required columns'} in this report`),
                  ),
                  h('p', { className: 'map-fail-body' },
                    'These fields need a column: ',
                    h('strong', null, missingReq.map(m => m.lb).join(', ')),
                    '. Click below to point them at the right columns.'),
                  h('button', { className: 'map-fail-btn', onClick: () => setMapAdjust(true) },
                    h('i', { className: 'ti ti-arrow-right', style: { fontSize: 13 } }), 'Update Report Mapping'),
                ),
                mapAdjust && h('div', { key: 'grid', className: 'map-wrap' },
                  h('div', { className: 'map-hdr' },
                    h('span', null, 'Field'), h('span', null, 'CSV column'), h('span', null, 'Sample'),
                  ),
                  ...MAP_FIELDS.map(({ f, lb, req }) => {
                    const needsFix = req && !colMap[f];
                    return h('div', { key: f, className: 'map-row' + (needsFix ? ' needs-fix' : '') },
                      h('div', { className: 'map-cell', style: { fontSize: 11 } }, lb, req && h('span', { className: 'req' }, '*'),
                        needsFix && h('span', { className: 'fix-tag' }, 'unmapped')),
                      h('div', { className: 'map-cell' },
                        h('select', { value: colMap[f], onChange: e => setColMap(p => ({ ...p, [f]: e.target.value })),
                          style: needsFix ? { borderColor: '#E24B4A' } : null },
                          h('option', { value: '' }, '— none —'),
                          ...csvHdrs.map(hdr => h('option', { key: hdr, value: hdr }, hdr.length > 24 ? hdr.substring(0, 24) + '…' : hdr)),
                        )
                      ),
                      h('div', { className: 'map-cell' }, h('span', { className: 'sample-val' }, sampleVal(f))),
                    );
                  })
                ),
                h('button', {
                  key: 'import', onClick: buildPreview, disabled: !allReqMapped,
                  style: allReqMapped
                    ? { fontSize: 16, fontWeight: 800, padding: '12px 32px', background: '#2563EB', color: '#fff', border: '2px solid #1D4FD7', borderRadius: 10, boxShadow: '0 2px 8px rgba(37,99,235,0.40)', cursor: 'pointer' }
                    : { fontSize: 16, fontWeight: 700, padding: '12px 32px', background: '#f0eeea', color: '#9a9a96', border: '2px solid #d0cfc9', borderRadius: 10 },
                }, h('i', { className: 'ti ti-check', style: { fontSize: 18, marginRight: 6 } }), 'Import'),
              ];
            })(),
          ),

          // Step 2: preview & apply
          iStep === 2 && h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
              h('button', { onClick: () => setIStep(1), style: { fontSize: 11, padding: '3px 8px' } },
                h('i', { className: 'ti ti-arrow-left', style: { fontSize: 11 } }), 'Back'),
              upCt > 0 && h('span', { className: 'badge', style: { background: '#E1F5EE', color: '#085041', border: '1px solid #1D9E75' } },
                h('i', { className: 'ti ti-refresh', style: { fontSize: 11, marginRight: 3 } }), `${upCt} update${upCt !== 1 ? 's' : ''}`),
              newCt > 0 && h('span', { className: 'badge', style: { background: '#E6F1FB', color: '#0C447C', border: '1px solid #378ADD' } },
                h('i', { className: 'ti ti-plus', style: { fontSize: 11, marginRight: 3 } }), `${newCt} new`),
            ),
            preview.length === 0 && h('p', { className: 'empty' }, 'No valid DIDs found with current mapping.'),
            preview.length > 0 && h('div', { className: 'preview-wrap' },
              h('table', { className: 'preview-tbl' },
                h('thead', null, h('tr', null, ...['DID','Status','Campaign','Calls','Answered','CR%','DNC','Score','Grade'].map(l => h('th', { key: l }, l)))),
                h('tbody', null, ...preview.slice(0, 8).map((row, i) => {
                  const g = row.grade ? GRADE[row.grade] : null;
                  return h('tr', { key: i },
                    h('td', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 10 } }, fmtDID(row.rawDid)),
                    h('td', null, h('span', { className: 'badge', style: { background: row.isUpdate ? '#E1F5EE' : '#E6F1FB', color: row.isUpdate ? '#085041' : '#0C447C', border: `1px solid ${row.isUpdate ? '#1D9E75' : '#378ADD'}` } }, row.isUpdate ? 'Update' : 'New')),
                    h('td', { style: { fontSize: 10, color: '#6b6b68' } }, row.campaign || '—'),
                    h('td', null, row.calls || '—'),
                    h('td', null, row.answered || '—'),
                    h('td', { style: { color: row.cr < 16 ? '#A32D2D' : row.cr < 22 ? '#854F0B' : '#27500A', fontWeight: 500 } }, row.cr ? row.cr.toFixed(1) + '%' : '—'),
                    h('td', { style: { color: (row.dncCount || 0) >= 4 ? '#A32D2D' : (row.dncCount || 0) >= 1 ? '#854F0B' : '#6b6b68' } }, row.dncCount || '0'),
                    h('td', { style: { fontWeight: 500 } }, row.score !== null ? row.score : '?'),
                    h('td', null, g
                      ? h('span', { className: 'badge', style: { background: g.bg, color: g.tx, border: `1px solid ${g.br}` } }, row.grade + ' ' + g.lb)
                      : h('span', { style: { color: '#bdbdb8', fontSize: 11 } }, '\u2014')),
                  );
                })),
              ),
              preview.length > 8 && h('div', { className: 'more-row' }, `+${preview.length - 8} more rows not shown`),
            ),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', {
                onClick: applyImport,
                style: { fontSize: 16, fontWeight: 800, padding: '12px 32px', background: '#16A34A', color: '#fff', border: '2px solid #128239', borderRadius: 10, boxShadow: '0 2px 8px rgba(22,163,74,0.40)', cursor: 'pointer' },
              }, h('i', { className: 'ti ti-check', style: { fontSize: 18, marginRight: 6 } }), `Apply ${preview.length} row${preview.length !== 1 ? 's' : ''}`),
              h('button', { onClick: () => { setImpOpen(false); resetImp(); }, style: { fontSize: 14, padding: '12px 18px', borderRadius: 10 } }, 'Cancel'),
            ),
          ),
        ),
      ),

      // Add DID form
      showAdd && h('div', { style: { border: '1px solid rgba(0,0,0,0.12)', borderRadius: 12, padding: 12, marginBottom: 10 } },
        h('div', { className: 'section-label' }, 'Add new DID'),
        h('div', { className: 'add-grid' },
          ...[
            { k: 'did',      ph: '12015717472',  lb: 'DID number',    cls: 'full' },
            { k: 'calls',    ph: '0',            lb: 'Calls' },
            { k: 'cr',       ph: '25.0',         lb: 'Contact rate %' },
            { k: 'dncCount', ph: '0',            lb: 'DNC count' },
            { k: 'notes',    ph: 'Notes…',       lb: 'Notes',         cls: 'full' },
          ].map(f => h('div', { key: f.k, className: 'field-wrap' + (f.cls ? ' ' + f.cls : '') },
            h('label', { className: 'field-label' }, f.lb),
            h('input', { value: form[f.k], placeholder: f.ph, onChange: e => setForm(p => ({ ...p, [f.k]: e.target.value })) }),
          ))
        ),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('button', { onClick: addDid, style: { fontSize: 12, padding: '5px 12px', background: '#EAF3DE', color: '#27500A', border: '1px solid #639922' } },
            h('i', { className: 'ti ti-check', style: { fontSize: 13 } }), 'Save'),
          h('button', { onClick: () => setShowAdd(false), style: { fontSize: 12, padding: '5px 10px' } }, 'Cancel'),
        ),
      ),

      // Filter tabs — status/grade tabs, then the workflow group (Swap / In Process / Replaced)
      h('div', { className: 'tabs-row' },
        h('div', { className: 'tabs' },
          ...TABS.filter(t => t.grp !== 'flow').map(t => h('button', {
            key: t.k,
            className: 'tab' + (filter === t.k ? ' active' : '') + (t.warn ? ' warn' : '') + (t.lit ? ' lit' : ''),
            onClick: () => setFilter(t.k),
          }, t.l))
        ),
        h('div', { className: 'tab-group' },
          h('span', { className: 'tab-group-label' },
            h('i', { className: 'ti ti-arrows-exchange', style: { fontSize: 12, marginRight: 4 } }), 'Replacement workflow'),
          h('div', { className: 'tab-group-tabs' },
            ...TABS.filter(t => t.grp === 'flow').map(t => h('button', {
              key: t.k,
              className: 'tab tab-' + t.k + (filter === t.k ? ' active' : '') + (t.lit ? ' lit' : ''),
              onClick: () => setFilter(t.k),
            }, t.l))
          ),
        ),
      ),

      // ── Queue All shortcut — shown only on At Risk/F tab ──
      filter === 'atrisk' && (() => {
        const actionable = enriched.filter(d =>
          (d.grade === 'D' || d.grade === 'F') &&
          !d.swapped && !isSent(d.did) && !isReplaced(d.did)
        ).length;
        return actionable > 0 && h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px', padding: '8px 12px', background: '#FCEBEB', border: '1px solid #E24B4A', borderRadius: 10 } },
          h('i', { className: 'ti ti-alert-triangle', style: { fontSize: 15, color: '#791F1F', flexShrink: 0 } }),
          h('span', { style: { fontSize: 12, color: '#791F1F', fontWeight: 600, flex: 1 } },
            `${actionable} unqueued At Risk / F number${actionable !== 1 ? 's' : ''} — add all to Swap Queue at once`),
          h('button', {
            onClick: bulkQueueAtRisk,
            style: { fontSize: 13, fontWeight: 800, padding: '7px 18px', background: '#E24B4A', color: '#fff', border: '2px solid #C23A39', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(226,75,74,0.35)' },
          },
            h('i', { className: 'ti ti-refresh', style: { fontSize: 14, marginRight: 5 } }),
            'Queue All (' + actionable + ')',
          ),
        );
      })(),

      // ── Notify Convoso — queue numbers and draft a replacement-request email ──
      hasNotifyContent && h('div', { className: 'panel', style: { marginBottom: 10, border: '1px solid #378ADD' } },
        h('button', {
          className: 'panel-trigger',
          onClick: () => setShowNotify(v => !v),
          style: { background: '#E6F1FB' },
        },
          h('i', { className: 'ti ti-mail-forward', style: { fontSize: 18, color: '#C0392B' } }),
          h('span', { style: { fontSize: 15, fontWeight: 800, color: '#C0392B' } }, 'Notify Convoso'),
          queued.length > 0
            ? h('span', { className: 'notify-meta', style: { fontSize: 12, color: '#0C447C', marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { fontSize: 13, fontWeight: 800, color: '#fff', background: '#C0392B', borderRadius: 12, padding: '1px 10px' } }, queuedNew.length + ' new'),
                (queuedResent.length ? h('span', { style: { color: '#6b6b68' } }, queuedResent.length + ' already replaced · ') : null),
                h('span', { style: { color: '#6b6b68' } }, 'Help@convoso.com'))
            : h('span', { style: { fontSize: 11, color: '#6b6b68', marginLeft: 4 } },
                '— click \u27f3 on any row below to queue numbers for Convoso'),
          h('i', { className: 'ti ' + (showNotify ? 'ti-chevron-up' : 'ti-chevron-down'), style: { marginLeft: 'auto', fontSize: 15, color: '#C0392B' } }),
        ),
        showNotify && h('div', { className: 'panel-body', style: { background: '#f7fbff' } },

          // (A) Post-draft confirmation: did the email actually go out?
          pendingSend && h('div', { className: 'send-confirm' },
            h('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 6 } },
              h('i', { className: 'ti ti-help-circle', style: { fontSize: 14, marginRight: 5 } }),
              'Did you send the email to Help@convoso.com?'),
            h('p', { style: { fontSize: 14, fontWeight: 700, color: '#1c1c1a', marginBottom: 10, lineHeight: 1.5 } },
              pendingSend.length + ' number' + (pendingSend.length !== 1 ? 's' : '') + ' were added to the draft. Confirm to track DID replacement process \u2014 or cancel if you didn\u2019t send.'),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                onClick: () => {
                  markSent(pendingSend);
                  setForceSend(prev => { const n = new Set(prev); pendingSend.forEach(p => n.delete(normPh(p.did))); return n; });
                  setPendingSend(null);
                  setFilter('all');
                },
                style: { fontSize: 15, padding: '12px 24px', borderRadius: 10, background: '#16A34A', color: '#fff', border: '2px solid #128239', fontWeight: 800, boxShadow: '0 2px 8px rgba(22,163,74,0.40)', cursor: 'pointer' },
              }, h('i', { className: 'ti ti-check', style: { fontSize: 17, marginRight: 4 } }), ' Yes, sent \u2014 mark as in process'),
              h('button', {
                onClick: () => setPendingSend(null),
                style: { fontSize: 14, padding: '12px 18px', borderRadius: 10, background: '#fff', color: '#6b6b68', border: '1.5px solid var(--br2)', cursor: 'pointer' },
              }, h('i', { className: 'ti ti-x', style: { fontSize: 15 } }), ' No, I cancelled it'),
            ),
          ),

          // (B) Already-sent numbers that are queued again — blocked with a warning + choices.
          queuedResent.length > 0 && h('div', { className: 'resent-warn' },
            h('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } },
              h('i', { className: 'ti ti-alert-triangle', style: { fontSize: 14, marginRight: 5 } }),
              queuedResent.length + ' queued number' + (queuedResent.length !== 1 ? 's were' : ' was') + ' already replaced'),
            h('p', { style: { fontSize: 11, marginBottom: 8, lineHeight: 1.5, opacity: 0.9 } },
              'These were already replaced by Convoso. They\u2019re held out of the email below. For each, send again anyway or remove it from this request.'),
            ...queuedResent.map(d => h('div', { key: d.id, className: 'resent-row' },
              h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 12 } },
                d.fmt,
                d.campaign ? h('span', { style: { fontSize: 10, opacity: 0.7, marginLeft: 8 } }, d.campaign) : null,
                h('span', { style: { fontSize: 9, fontWeight: 700, marginLeft: 8, padding: '1px 5px', borderRadius: 3, background: '#eae3f5', color: '#4a2d79' } },
                  'ALREADY REPLACED'),
                (entryOf(d.did) && entryOf(d.did).resendCount > 0) ? h('span', { className: 'resend-badge', title: 'Times this DID has been re-sent after a replacement' }, '\u21ba ' + entryOf(d.did).resendCount + 'x') : null),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('button', {
                  onClick: () => setForceSend(prev => { const n = new Set(prev); n.add(normPh(d.did)); return n; }),
                  title: 'Send again: adds it to the email below while keeping its tracked record',
                  style: { fontSize: 10, padding: '2px 8px', borderRadius: 6, background: '#fff', color: '#854F0B', border: '1px solid #BA7517', cursor: 'pointer' },
                }, 'Send anyway'),
                h('button', {
                  onClick: () => toggleSwap(d.id),
                  title: 'Remove from this replacement email',
                  style: { fontSize: 10, padding: '2px 8px', borderRadius: 6, background: '#fff', color: '#791F1F', border: '1px solid #E24B4A', cursor: 'pointer' },
                }, 'Remove'),
              ),
            )),
          ),

          // (C) New numbers ready to send.
          queuedNew.length === 0 && queuedResent.length === 0
            ? h('p', { style: { fontSize: 12, color: '#6b6b68', textAlign: 'center', padding: '8px 0' } },
                'No numbers queued. Click the ', h('strong', null, '\u27f3'),
                ' icon on any row to add it here, then send to Help@convoso.com.')
            : queuedNew.length > 0 && h('div', null,
                h('p', { style: { fontSize: 11, color: '#6b6b68', marginBottom: 8, lineHeight: 1.6 } },
                  queuedNew.length + ' new number' + (queuedNew.length !== 1 ? 's' : '') + ' ready for ',
                  h('strong', null, 'Help@convoso.com'), '.'),
                h('div', { style: { border: '1px solid #c2dcf5', borderRadius: 8, background: '#fff', padding: '6px 10px', fontFamily: 'ui-monospace,monospace', fontSize: 12, lineHeight: 2, marginBottom: 8, maxHeight: 180, overflowY: 'auto' } },
                  queuedNew.map((d, i, arr) =>
                    h('div', { key: d.id, style: { display: 'flex', justifyContent: 'space-between', borderBottom: i < arr.length - 1 ? '1px solid #eef4fb' : 'none' } },
                      h('span', null, d.fmt, d.campaign ? h('span', { style: { fontSize: 10, color: '#9a9a96', marginLeft: 8 } }, d.campaign) : null),
                      h('span', { style: { fontSize: 10, color: '#6b6b68' } }, d.grade ? 'Grade ' + d.grade + ' \u00b7 Score ' + d.score : '\u2014')
                    )
                  )
                ),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', {
                    onClick: () => {
                      const nums = queuedNew.map(d => d.fmt).join('\n');
                      navigator.clipboard.writeText(nums).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); });
                    },
                    style: { fontSize: 12, padding: '5px 14px', background: copied ? '#EAF3DE' : '#E6F1FB', color: copied ? '#27500A' : '#0C447C', border: '1px solid ' + (copied ? '#639922' : '#378ADD'), fontWeight: 500, cursor: 'pointer', borderRadius: 8 },
                  },
                    h('i', { className: 'ti ' + (copied ? 'ti-check' : 'ti-copy'), style: { fontSize: 13 } }),
                    ' ' + (copied ? 'Copied!' : 'Copy all ' + queuedNew.length + ' number' + (queuedNew.length !== 1 ? 's' : '')),
                  ),
                  h('a', {
                    href: buildEmailHref(queuedNew),
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    onClick: () => setPendingSend(queuedNew.map(d => ({ did: d.did, campaign: d.campaign }))),
                    style: { fontSize: 16, color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', padding: '12px 28px', borderRadius: 10, background: '#2563EB', border: '2px solid #1D4FD7', fontWeight: 800, boxShadow: '0 2px 8px rgba(37,99,235,0.40)' },
                  },
                    h('i', { className: 'ti ti-mail-forward', style: { fontSize: 18 } }),
                    'Begin Email Draft',
                  ),
                ),
              ),

        ),
      ),

      // Campaign filter bar (between status tabs and the table headers).
      // Uses allCampaigns so EVERY campaign chip stays visible when one is selected.
      allCampaigns.length > 0 && h('div', { className: 'camp-bar' },
        h('span', { className: 'camp-bar-label' },
          h('i', { className: 'ti ti-folders', style: { fontSize: 13, marginRight: 5 } }), 'Campaign'),
        h('button', {
          className: 'camp-chip' + (campFilter === 'all' ? ' active' : ''),
          onClick: () => setCampFilter('all'),
        }, 'All campaigns'),
        ...allCampaigns.map(([name, n]) => h('button', {
          key: name,
          className: 'camp-chip' + (campFilter === name ? ' active' : ''),
          onClick: () => setCampFilter(campFilter === name ? 'all' : name),
        }, name, h('span', { className: 'camp-chip-n' }, n))),
      ),

      // Campaign health summary — per-campaign risk breakdown
      campaigns.length > 1 && campFilter === 'all' && (() => {
        // Build per-campaign stats — watch/atRisk/dncAlert match the table (exclude In Process + Replaced)
        const campStats = new Map();
        for (const d of enriched) {
          const c = d.campaign || 'Unassigned';
          if (!campStats.has(c)) campStats.set(c, { total: 0, watch: 0, atRisk: 0, dncAlert: 0, inProc: 0 });
          const s = campStats.get(c);
          const sent     = isSent(d.did);
          const replaced = isReplaced(d.did);
          if (sent)     { s.inProc++; s.total++; continue; }
          if (replaced) { s.total++; continue; }
          s.total++;
          if (d.grade === 'C') s.watch++;
          if (d.grade === 'D' || d.grade === 'F') s.atRisk++;
          if ((d.dncCount || 0) >= 4 && (d.calls || 0) > 50 && (d.cr || 0) <= 25) s.dncAlert++;
        }
        const sorted = [...campStats.entries()].sort(([a], [b]) => campSort(a, b));
        const anyIssues = sorted.some(([, s]) => s.atRisk > 0 || s.dncAlert > 0 || s.watch > 0);
        if (!anyIssues) return null;
        return h('div', { className: 'camp-health' },
          h('div', { className: 'camp-health-hd' },
            h('i', { className: 'ti ti-chart-bar', style: { fontSize: 13, marginRight: 5 } }),
            'Campaign health',
          ),
          h('div', { className: 'camp-health-grid' },
            ...sorted.map(([name, s]) => h('div', {
              key: name,
              className: 'camp-health-row' + (s.atRisk > 0 || s.dncAlert > 0 || s.watch > 0 ? ' has-issues' : ''),
              onClick: () => setCampFilter(name),
              title: 'Filter to ' + name,
            },
              h('span', { className: 'camp-health-name' }, name),
              h('span', { className: 'camp-health-chips' },
                s.atRisk > 0 && h('span', { className: 'chp chp-risk' },
                  h('i', { className: 'ti ti-alert-triangle', style: { fontSize: 9, marginRight: 2 } }),
                  s.atRisk + ' at risk'),
                s.watch > 0 && h('span', { className: 'chp chp-watch' },
                  h('i', { className: 'ti ti-eye', style: { fontSize: 9, marginRight: 2 } }),
                  s.watch + ' watch'),
                s.dncAlert > 0 && h('span', { className: 'chp chp-dnc' },
                  h('i', { className: 'ti ti-phone-off', style: { fontSize: 9, marginRight: 2 } }),
                  s.dncAlert + ' DNC'),
                s.inProc > 0 && h('span', { className: 'chp chp-proc' },
                  h('i', { className: 'ti ti-clock', style: { fontSize: 9, marginRight: 2 } }),
                  s.inProc + ' in process'),
                s.atRisk === 0 && s.watch === 0 && s.dncAlert === 0 && h('span', { className: 'chp chp-ok' },
                  h('i', { className: 'ti ti-circle-check', style: { fontSize: 9, marginRight: 2 } }),
                  'Clean'),
              ),
              h('span', { className: 'camp-health-total' }, s.total + ' DIDs'),
            ))
          ),
        );
      })(),

      // Unassigned warning — fires when DIDs couldn't be matched to a campaign column
      unassignedCount > 0 && h('div', { className: 'camp-warn' },
        h('i', { className: 'ti ti-alert-triangle', style: { fontSize: 15, flexShrink: 0 } }),
        h('div', null,
          h('div', { style: { fontWeight: 600 } },
            `${unassignedCount} DID${unassignedCount === 1 ? '' : 's'} couldn't be matched to a campaign`),
          h('div', { style: { fontSize: 11, marginTop: 2, opacity: 0.85 } },
            'The dropped report may use a campaign column format this tool doesn\u2019t recognize. These DIDs are grouped under "Unassigned" below.'),
        ),
      ),

      // DID search bar
      enriched.length > 0 && h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px' } },
        h('div', { style: { position: 'relative', flex: 1, maxWidth: 320 } },
          h('i', { className: 'ti ti-search', style: { position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#9a9a96', pointerEvents: 'none' } }),
          h('input', {
            type: 'text',
            className: 'did-search',
            placeholder: 'Search numbers…',
            value: didSearch,
            onChange: e => setDidSearch(e.target.value),
            style: { width: '100%', paddingLeft: 30, paddingRight: didSearch ? 28 : 10, paddingTop: 6, paddingBottom: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' },
          }),
          didSearch && h('button', {
            className: 'search-clear',
            onClick: () => setDidSearch(''),
            style: { position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9a9a96', fontSize: 14, lineHeight: 1, padding: 0 },
          }, h('i', { className: 'ti ti-x' })),
        ),
        didSearch && h('span', { style: { fontSize: 12, color: '#6b6b68' } }, filtered.length + ' match' + (filtered.length !== 1 ? 'es' : '')),
      ),

      // Main table
      h('div', { className: 'tbl-wrap' },
        h('table', { className: 'tbl' },
          h('colgroup', null,
            h('col', { style: { minWidth: 125 } }),
            h('col', { style: { minWidth: 38  } }),
            h('col', { style: { minWidth: 48  } }),
            h('col', { style: { minWidth: 60  } }),
            h('col', { style: { minWidth: 56  } }),
            h('col', { style: { minWidth: 54  } }),
            h('col', { style: { minWidth: 80  } }),
            h('col', { style: { minWidth: 82  } }),
            h('col', { style: { minWidth: 92  } }),
          ),
          h('thead', null, h('tr', null,
            ...[
              { c: 'fmt',    l: 'Number'  },
              { c: 'area',   l: 'Area'    },
              { c: 'calls',  l: 'Calls'   },
              { c: 'answered', l: 'Answered' },
              { c: 'cr',     l: 'CR %'    },
              { c: 'dncCount', l: 'DNC'     },
              { c: 'score',  l: 'Score'   },
              { c: 'grade',  l: 'Grade'   },
              { c: null,     l: ''        },
            ].map(col => h('th', { key: col.l || 'act', onClick: () => col.c && toggleSort(col.c) }, col.l + arrow(col.c)))
          )),
          h('tbody', null, ...(() => {
            // Group the current PAGE of rows by campaign, preserving sort within each group.
            const groups = new Map();
            for (const did of pageRows) {
              const c = did.campaign || 'Unassigned';
              if (!groups.has(c)) groups.set(c, []);
              groups.get(c).push(did);
            }
            const ordered = [...groups.entries()].sort(([a], [b]) => campSort(a, b));
            const out = [];
            for (const [cname, rows] of ordered) {
              // Band totals come from campTotals -- the FULL campaign across every page --
              // so they stay fixed when you sort or page instead of reflecting only the
              // <=100 rows currently visible. `shown` is how many are on this page.
              const ct    = campTotals.get(cname) || { count: rows.length, calls: 0, ans: 0, flagged: 0 };
              const shown = rows.length;
              out.push(h('tr', { key: 'band-' + cname, className: 'camp-band' },
                h('td', { colSpan: 9 },
                  h('span', { className: 'camp-band-name' }, cname),
                  h('span', { className: 'camp-band-meta' },
                    `${ct.count.toLocaleString()} DIDs · ${ct.calls.toLocaleString()} calls · ${ct.ans.toLocaleString()} answered · `,
                    h('span', { className: 'camp-band-cr' },
                      `${ct.calls ? (ct.ans / ct.calls * 100).toFixed(1) : '0.0'}%`,
                      h('span', { className: 'camp-band-cr-lbl' }, ' CR')),
                    shown < ct.count && h('span', { style: { fontSize: 10, color: '#6b6b68', fontWeight: 500, marginLeft: 8 } }, `showing ${shown.toLocaleString()} here`),
                    ct.flagged > 0 && h('span', { className: 'camp-band-flag' }, `${ct.flagged} at risk`),
                  ),
                )
              ));
              for (const did of rows) {
                const g = did.grade ? GRADE[did.grade] : null;
                const crColor    = did.cr < 16 ? '#A32D2D' : did.cr < 22 ? '#854F0B' : '#27500A';
                // O(1) Set lookups — no closure re-evaluation per row
                const didSent     = sentSet.has(normPh(did.did));
                const didReplaced = replacedSet.has(normPh(did.did));
                out.push(h('tr', { key: did.id, style: { opacity: did.swapped ? 0.6 : 1 } },
                  h('td', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 13, fontWeight: 700, color: '#12172a', letterSpacing: '0.01em' } },
                    did.fmt,
                    did.swapped && h('span', { className: 'swap-tag' }, 'SWAP'),
                    didSent && h('span', { className: 'sent-tag', title: 'Sent to Convoso \u2014 replacement in process' }, 'IN PROCESS'),
                    didReplaced && h('span', { className: 'replaced-tag', title: 'Confirmed replaced \u2014 on record' }, 'REPLACED'),
                    didReplaced && entryOf(did.did) && entryOf(did.did).replacedAt && h('span', { style: { fontSize: 11, fontWeight: 700, color: '#6b4f9e', marginLeft: 6 }, title: 'Date Convoso replaced this number' }, 'replaced ' + new Date(entryOf(did.did).replacedAt).toLocaleDateString()),
                    did.calls < 25 && h('span', { title: 'Low data: <25 calls', style: { fontSize: 10, color: '#9a9a96', marginLeft: 4 } },
                      h('i', { className: 'ti ti-dots', style: { fontSize: 10 } })),
                  ),
                  h('td', { style: { color: '#6b6b68', fontWeight: 500, fontSize: 11 } }, did.area),
                  h('td', null, did.calls),
                  h('td', { style: { color: '#6b6b68' } }, did.answered != null ? did.answered : '—'),
                  h('td', { style: { color: crColor, fontWeight: 500 } }, did.cr.toFixed(1) + '%'),
                  h('td', null, (did.dncCount || 0) > 0
                    ? h('span', { className: 'dnc-pill', style: { background: (did.dncCount || 0) >= 4 ? '#FCEBEB' : '#FAECE7', color: (did.dncCount || 0) >= 4 ? '#791F1F' : '#712B13' } }, did.dncCount)
                    : h('span', { style: { color: '#9a9a96', fontSize: 11 } }, '—')
                  ),
                  h('td', null, did.score !== null
                    ? h('div', { className: 'score-wrap' },
                        h('div', { className: 'score-bg' },
                          h('div', { style: { width: `${did.score}%`, height: '100%', background: g ? g.br : '#ccc', borderRadius: 2 } })),
                        h('span', { style: { fontSize: 12, fontWeight: 500, minWidth: 22, textAlign: 'right' } }, did.score),
                      )
                    : h('span', { style: { color: '#9a9a96', fontSize: 11 } }, '—')
                  ),
                  h('td', null, g
                    ? h('span', { className: 'badge', style: { background: g.bg, color: g.tx, border: `1px solid ${g.br}` } }, did.grade + ' ' + g.lb)
                    : h('span', { style: { color: '#bdbdb8', fontSize: 12 } }, '\u2014')
                  ),
                  h('td', null,
                    h('div', { className: 'action-btns' },
                      didSent
                        ? [
                            h('span', { key: 'lock', className: 'inproc-lock', title: 'Emailed to Convoso — in replacement process' },
                              h('i', { className: 'ti ti-clock-hour-4', style: { fontSize: 12, marginRight: 3 } }), 'In Process'),
                            h('button', { key: 'mr', className: 'mark-replaced-btn', onClick: () => markReplaced(did.did),
                              title: 'Confirm Convoso replaced this \u2014 move to Replaced' },
                              h('i', { className: 'ti ti-check', style: { fontSize: 13, marginRight: 4 } }), 'Mark replaced'),
                            h('button', { key: 'cancel',
                              onClick: () => { if (confirm('Cancel replacement for ' + did.fmt + '?\n\nThis removes it from In Process and returns it to the active pool. It will NOT come back as In Process when you reload a report. Use this if it was sent by mistake or Convoso will not be replacing it.')) removeEntry(did.did); },
                              title: 'Undo In Process \u2014 clear the tracking record and return this DID to the active pool',
                              style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '9px 14px', borderRadius: 9, background: '#fff', color: '#6b6b68', border: '1.5px solid #b8bfc8', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' } },
                              h('i', { className: 'ti ti-arrow-back-up', style: { fontSize: 14, marginRight: 3 } }), 'Cancel'),
                          ]
                        : didReplaced
                          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
                              h('span', { className: 'replaced-lock', title: 'Confirmed replaced by Convoso' },
                                h('i', { className: 'ti ti-circle-check', style: { fontSize: 12, marginRight: 3 } }), 'Replaced'),
                              h('button', {
                                className: 'restore-btn',
                                onClick: () => { if (confirm('Remove the "Replaced" classification from ' + did.fmt + '? This will restore it to the active pool so it can be flagged for swap again.')) restoreToActive(did.did); },
                                title: 'Remove Replaced classification \u2014 restores DID to active pool',
                              }, h('i', { className: 'ti ti-rotate', style: { fontSize: 12, marginRight: 3 } }), 'Restore'),
                            )
                          : (() => {
                              const atRisk = did.grade === 'F' || did.grade === 'D';
                              const watch  = did.grade === 'C';
                              const cls = did.swapped ? 'queued' : atRisk ? 'swap-risk' : watch ? 'swap-watch' : 'swap-normal';
                              return h('button', {
                                className: `swap-btn ${cls}`,
                                onClick: () => toggleSwap(did.id),
                                title: did.swapped ? 'Remove from queue' : (atRisk ? 'At risk \u2014 flag for swap' : watch ? 'Watch \u2014 flag for swap' : 'Flag for swap'),
                              },
                                h('i', { className: `ti ${did.swapped ? 'ti-x' : 'ti-refresh'}`, style: { fontSize: did.swapped ? 14 : atRisk ? 17 : watch ? 15 : 14 } }),
                                did.swapped ? ' Remove' : atRisk ? ' Swap' : watch ? ' Swap' : null,
                              );
                            })(),
                      h('button', { className: 'action-btn', onClick: () => retire(did.id), title: 'Retire' },
                        h('i', { className: 'ti ti-trash' })),
                    )
                  ),
                ));
              }
            }
            return out;
          })()),
        ),
        filtered.length === 0 && h('div', { className: 'empty' }, 'No numbers in this category.'),
        // Pagination bar — only renders when the row count exceeds one page
        totalPages > 1 && h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--br)', background: 'var(--bg2)', borderRadius: '0 0 10px 10px', fontSize: 12, color: 'var(--tx2)' } },
          h('button', {
            onClick: () => setPage(p => Math.max(0, p - 1)),
            disabled: safePage === 0,
            style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--br2)', background: safePage === 0 ? 'var(--bg3)' : 'var(--bg)', cursor: safePage === 0 ? 'default' : 'pointer', color: safePage === 0 ? 'var(--tx3)' : 'var(--tx)', fontWeight: 600, fontSize: 12 },
          }, h('i', { className: 'ti ti-chevron-left', style: { fontSize: 11 } }), ' Prev'),
          h('span', { style: { fontWeight: 500 } },
            `Page ${safePage + 1} of ${totalPages}`,
            h('span', { style: { marginLeft: 8, color: 'var(--tx3)', fontWeight: 400 } },
              `(${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length})`
            ),
          ),
          h('button', {
            onClick: () => setPage(p => Math.min(totalPages - 1, p + 1)),
            disabled: safePage >= totalPages - 1,
            style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--br2)', background: safePage >= totalPages - 1 ? 'var(--bg3)' : 'var(--bg)', cursor: safePage >= totalPages - 1 ? 'default' : 'pointer', color: safePage >= totalPages - 1 ? 'var(--tx3)' : 'var(--tx)', fontWeight: 600, fontSize: 12 },
          }, 'Next ', h('i', { className: 'ti ti-chevron-right', style: { fontSize: 11 } })),
        ),
      ),

      // Scoring legend
      h('div', { className: 'panel', style: { marginTop: 10 } },
        h('button', { className: 'panel-trigger', onClick: () => setShowLegend(v => !v) },
          h('i', { className: 'ti ti-info-circle', style: { fontSize: 15, color: '#6b6b68' } }),
          h('span', { style: { fontSize: 12, fontWeight: 500 } }, 'Scoring methodology'),
          h('span', { style: { fontSize: 11, color: '#9a9a96', marginLeft: 4 } }, '— calibrated to this report pool'),
          h('i', { className: `ti ${showLegend ? 'ti-chevron-up' : 'ti-chevron-down'}`, style: { marginLeft: 'auto', fontSize: 13, color: '#6b6b68' } }),
        ),
        showLegend && h('div', { className: 'panel-body' },
          h('div', { className: 'legend-grid' },
            ...[
              { t: 'Contact rate (−55 max)',  r: ['≥28% — no penalty','24–27% — −4','20–23% — −10','16–19% — −20','12–15% — −34','8–11% — −45','<8% — −55'] },
              { t: 'Call volume (−20 max)',   r: ['≤50 — no penalty','51–150 — −3','151–300 — −8','301–500 — −14','>500 — −20'] },
              { t: 'DNC count (−25 max)',     r: ['0 — no penalty','1 — −3','2–3 — −8','4–6 — −14','7–9 — −20','≥10 — −25'] },
              { t: 'Low data',               r: ['<25 calls — unscored (—)','≥25 calls — fully graded'] },
              { t: 'DNC Alert triggers when ALL:',  r: ['DNC count ≥ 4','Calls > 50','Contact rate ≤ 25%'] },
            ].map(s => h('div', { key: s.t, className: 'legend-sec' },
              h('h4', null, s.t),
              h('p', null, s.r.join('\n')),
            ))
          ),
          h('div', { className: 'grade-pills' },
            ...Object.entries(GRADE).map(([g, c]) => h('span', { key: g, className: 'badge', style: { background: c.bg, color: c.tx, border: `1px solid ${c.br}` } },
              `${g}: ${c.lb} (${c.rng})`))
          ),
        ),
      ),
    ),
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('app')).render(h(App));
