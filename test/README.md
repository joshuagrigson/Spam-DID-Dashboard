# Tests

    ./test/run.sh          # everything
    npm --prefix test i    # once, for react/react-dom (render + integration suites)

Four suites, no browser needed:

| Suite | What it protects |
|---|---|
| **syntax** | `node --check` on every shipped script. |
| **collisions** | `analytics.js` and `app.js` share one browser script scope. A duplicated top-level `const` is a fatal `SyntaxError` that blanks the page — this catches it before deploy. |
| **engine** | Snapshot merge/prune, trend math, the four vendor adapters, reputation roll-up, the diagnosis ordering, buy-list arithmetic, edge cases. |
| **render** | Every view rendered through real React (`renderToStaticMarkup`), populated *and* empty, with React's own warnings treated as failures. |
| **integration** | Loads `data.js` → `analytics.js` → `app.js` into one shared scope exactly as `index.html` does, then renders the real `App` on all nine analytics sub-tabs. |

The engine suite is the one to extend when the scoring or diagnosis rules change.
It encodes the model's central claim as an executable test: *the same 7% contact
rate is `burned` when carriers flag the number and `list_problem` when they call
it clean.* If that test ever fails, the two-axis model has been broken.
