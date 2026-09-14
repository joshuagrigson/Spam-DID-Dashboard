#!/usr/bin/env bash
# DID Dashboard — test suite. No browser required; the intelligence layer is
# pure logic plus React components that render server-side.
#   ./test/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0

echo "── 1/4  syntax ──────────────────────────────────────────"
for f in analytics.js app.js data.js; do
  node --check "$f" && echo "  ok  $f" || { echo "  FAIL  $f"; FAIL=1; }
done

echo
echo "── 2/4  global scope collisions ─────────────────────────"
# analytics.js and app.js share ONE script scope in the browser. A duplicated
# top-level const is a fatal SyntaxError that takes the whole page down.
COLL=$(comm -12 \
  <(grep -oE "^(const|let|var|function) [A-Za-z_$][A-Za-z0-9_$]*" app.js       | awk '{print $2}' | sort -u) \
  <(grep -oE "^(const|let|var|function) [A-Za-z_$][A-Za-z0-9_$]*" analytics.js | awk '{print $2}' | sort -u))
if [ -n "$COLL" ]; then echo "  FAIL  duplicated top-level names:"; echo "$COLL" | sed 's/^/        /'; FAIL=1
else echo "  ok  no duplicated top-level declarations"; fi

echo
echo "── 3/4  engine + render ─────────────────────────────────"
# Built inside test/ so __dirname and node_modules resolution both work.
mkdir -p test/.build
cat test/stubs.js analytics.js test/engine.test.js > test/.build/engine.js
node test/.build/engine.js | tail -4 || FAIL=1
cat test/render-stubs.js analytics.js test/render.test.js > test/.build/render.js
node test/.build/render.js 2>&1 | tail -4 || FAIL=1

echo
echo "── 4/4  full-page integration ───────────────────────────"
node test/integration.test.js | tail -4 || FAIL=1

echo
[ $FAIL -eq 0 ] && echo "ALL SUITES PASS" || echo "SUITES FAILED"
exit $FAIL
