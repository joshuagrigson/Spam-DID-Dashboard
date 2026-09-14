# DID Dashboard — OCR

Spam-risk and contact-rate monitoring for the Southern Tier DID pool.
Static site: React 18 UMD + PapaParse from CDN, **no build step**. Open
`index.html` and it runs.

**Verified against deployed v6.24.0 on 2026-09-14.**
Source of truth is <https://didspamdashboard.netlify.app/>. Pull live → patch →
deploy → resync. Never the reverse. A version stamp that no longer matches the
live header is the signal that this file has drifted.

## Files

| File | Role |
|---|---|
| `index.html` | Shell. Script order matters: `data.js` → **`analytics.js`** → `app.js`. |
| `app.js` | Pool table, import wizard, swap queue, the original analytics boards. |
| `analytics.js` | Intelligence layer: snapshots, reputation, diagnosis, the four new tabs. |
| `style.css` / `analytics.css` | Styles. Everything in the second file is `dx-` prefixed. |
| `data.js` | `const INIT = []` by design. The pool lives in `localStorage`. |
| `test/` | Four suites, no browser required. `./test/run.sh`. |

> `analytics.js` and `app.js` share **one** browser script scope. A duplicated
> top-level `const` is a fatal `SyntaxError` that blanks the page. `./test/run.sh`
> checks for this — run it before every deploy.

## Stored state (localStorage, per browser)

| Key | Holds |
|---|---|
| `did_monitor_pool_v1` | Current pool. Overwritten on each import. |
| `did_monitor_snapshots_v1` | **Dated history.** One entry per calendar day, same-day imports merged. Cap 120 days / ~2MB, oldest pruned first. |
| `did_monitor_reputation_v1` | Carrier scan results, keyed by number, one record per vendor. |
| `did_monitor_firstseen_v1` | Immutable first-observation stamp per number. |
| `did_monitor_sent_v1` | Swap queue / replacement ledger. |

Deploying does **not** wipe any of these. They are per-browser and are not
shared between people.

## The scoring model

`calcScore()` in `app.js` is unchanged from v6.22.0 — start at 100, then:

- **Contact rate** (−55 max, rebased 2026-08-19 to the ~19% pool average):
  `<8% −55 · <12 −45 · <16 −34 · <20 −20 · <24 −10 · <28 −4`
- **Call volume** (−20 max): `>500 −20 · >300 −14 · >150 −8 · >50 −3`
- **DNC count** (−25 max, by COUNT not rate): `≥10 −25 · ≥7 −20 · ≥4 −14 · ≥2 −8 · ≥1 −3`

Under **25 calls** a number is unscored (`null`). **There is no cap** anywhere.
Grades: A ≥80, B ≥65, C ≥50, D ≥35, F below.
DNC Alert rule: `dncCount >= 4 && calls > 50 && cr <= 25` — a three-way AND, so
stray DNC hits on low-volume or otherwise-healthy numbers do not alert.

## The intelligence layer (v6.24.0)

### Why snapshots exist
Every import used to overwrite the pool, so all previous data was destroyed and
no trend could be computed. `analytics.js` now records a dated snapshot on every
import. **Nothing is back-filled** — history runs from the first import after
this shipped, and the Trends tab says so rather than pretending otherwise.

Contact rate is the trendable metric: it is a ratio and compares cleanly between
reports. Raw call **counts** depend on the window each report was pulled over,
which the app cannot verify, so volume is labelled "as reported" and never drives
a recommendation on its own.

### The two-axis model — the point of the whole thing
- **Axis 1, reputation (measured):** do the carriers actually flag this number?
  Imported from Convoso Ignite, CallPurity, DNC.com, Caller ID Reputation.
- **Axis 2, performance (inferred):** is it converting relative to the other
  numbers in its **own** area code?

Contact rate alone cannot tell a burned number from a bad list, and the two have
opposite fixes. This resolves the open question left by the 2026-08-19 scoring
review ("is low CR on a zero-DNC number a spam signal, or a list artifact?"):
**with a scan on record, it is answerable; without one, it is not.**

Diagnoses, in priority order. **Measured beats inferred** — a number the carriers
looked at and called clean is not sentenced as damaged on an inference the scan
just contradicted:

| Diagnosis | Sev | Meaning |
|---|---|---|
| `burned` | 4 | Flagged **and** damaged/DNC-heavy. Replace. |
| `collapsing` | 4 | Contact rate down ≥35% relative. Pull it now — scans go stale. |
| `flagged_ok` | 3 | Flagged but still converting. **Remediate before replacing.** |
| `falling` | 3 | Down ≥20% relative. Rest it, scan it. |
| `dnc` | 3 | 4+ DNC requests. Real regardless of carrier status. |
| `list_problem` | 2 | **Carriers say clean, still underperforming → do not replace.** Look at the list, hours, offer. |
| `damaged` | 3 | Trails its own area code, no scan on record. Scan before buying a replacement. |
| `unknown_low` | 2 | Low rate, never scanned, too few area-code peers to compare. |
| `overworked` | 2 | Carrying ≥2× the pool's calls-per-number. Add depth. |
| `recovering` / `healthy` / `nodata` | 1 / 0 / 0 | No action. |

A direction is only called when the **relative** move (≥20%) and the **absolute**
move (≥1.5 points) agree, so 0.4% → 0.3% is not reported as a 25% collapse.

### Reputation import
Two routes, neither needing credentials in the app:
1. **File** — any CSV/TSV export from the four tools.
2. **Paste** — copy the results table out of the tool's own web UI and paste it.
   The browser you are already signed into does the reading; only the result
   crosses over. No API key, no backend, no CORS problem.

Columns are matched by **meaning**, not by a memorized header list, so a renamed
export still imports; the detected mapping is shown and every column can be
overridden before committing. Per-carrier columns (AT&T, T-Mobile, Verizon,
Hiya, TNS, First Orion, Nomorobo, …) are recognized individually.

**Any source reporting a flag counts as flagged.** These tools each see a
different slice of the ecosystem, so a "clean" from one is not a clean from all —
but a "flagged" from one is real. A number with no scan is shown as **unknown**,
never assumed clean.

### Getting the data in when a tool has no export
Ignite / CallPurity / DNC.com / Caller ID Reputation are web-UI-first. When you
select a table in a page and copy it, the browser puts **two** flavours on the
clipboard: `text/plain` (whatever the page's whitespace collapsed to — ragged,
columns sometimes run together) and `text/html` (the actual table structure).
The paste lane reads the **HTML** flavour first and only falls back to delimited
text, which is what makes copy-paste reliable rather than hit-and-miss. Nested
tags, `&nbsp;`, HTML entities and a title/toolbar row above the header are all
handled. Nothing leaves the browser and no credential is ever entered here.

### Back-fill
Trends need two observations, so without back-fill the tab is empty until your
next import and useful only after the one after that. **Trends → Back-fill from
saved reports** replays saved Convoso Contact Rate Reports as dated snapshots:
select several at once, dates are read from the filename where recognisable
(`2026-08-01`, `9-14-2026`, `20260703`) and are editable per row.

Back-fill writes **snapshots only** — it never touches the live pool, so
replaying six months of old reports cannot disturb what is on screen. Re-running
it updates the same day rather than duplicating it. It parses reports through
app.js's own `autoDetect()`, so back-fill and live import agree by construction.

### Buy list
Area codes cannot be shopped around under local presence, so the only lever is
**depth**: how many *working* numbers carry that area code's volume. "Working"
excludes anything diagnosed burned, collapsing, damaged, flagged or DNC-pressured.

    need = ceil(area code calls / target per number) − working numbers

Target is adjustable (default 200). Ordered by **exposed call volume**, not by
how bad the percentage looks. Area codes under 3 numbers or 200 calls get **no
recommendation at all** — they are listed separately as "not enough data to
call", because a purchase recommendation off that much data is a guess wearing
a number.

## Deploying

The site is on Netlify (`didspamdashboard`). Deploying = uploading the five
static files plus `analytics.js` / `analytics.css`. Historically the Netlify
connector's `npx` path has been blocked from sandboxes and a PAT against
`api.netlify.com` was the working route; drag-and-drop in the Netlify UI always
works. Run `./test/run.sh` first — it catches the class of error (scope
collision) that would blank the page.
