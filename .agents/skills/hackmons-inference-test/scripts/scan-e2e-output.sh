#!/usr/bin/env bash
# Summarize a custom Hackmons inference e2e run (scripts/e2e-custom-hackmons-debug.mjs output).
# Usage: scan-e2e-output.sh <path-to-captured-output>
#
# Prints the signals you actually need to judge a run, so you don't re-derive greps each time:
#   - which scenario ran + whether it reached the final snapshot
#   - hard failures (handshake/battle-room/timeout/unknown scenario)
#   - damageMismatches (estimate's observed% vs the script's independent parse) -- should be empty
#   - confidence + inferred-nature histograms across the run
#   - UI-freeze signal ("Progress wait timed out") -- should be 0
#   - the final spreadVerification deltas (estimate stats vs the known real spread)
set -euo pipefail

f="${1:-}"
if [ -z "$f" ] || [ ! -f "$f" ]; then
  echo "usage: $0 <path-to-e2e-output-file>" >&2
  exit 2
fi

# NOTE: the estimate text lives inside JSON strings, so newlines appear as the literal two
# characters backslash-n. In ERE, '\\n' matches a literal backslash followed by 'n'.

echo "=== scenario / completion ==="
grep -E "Using scenario|Final custom Hackmons debug snapshot" "$f" || echo "(scenario/final markers not found)"

echo
echo "=== hard failures (should be none) ==="
if grep -nE "TimeoutError|Name handshake failed|Could not submit|Battle room wait failed|Unknown SCENARIO|Node\.js v[0-9]" "$f"; then
  echo ">> run did NOT finish cleanly (a startup TimeoutError is usually a transient flake -- just retry)"
else
  echo "(none)"
fi

echo
echo "=== UI-freeze signal (Progress wait timed out) ==="
echo "count: $(grep -c "Progress wait timed out" "$f" || true)   (expect 0)"

echo
echo "=== damageMismatches (expect 0 non-empty) ==="
mm=$(grep -c '"damageMismatches": \[$' "$f" || true)
echo "non-empty blocks: $mm"
if [ "${mm:-0}" -gt 0 ]; then
  echo ">> first non-empty block:"
  awk '/"damageMismatches": \[$/{c++; p=1} p{print} /^  \],?$/{if(p){p=0; if(c==1) exit}}' "$f" | sed -n '1,20p'
  echo ">> mismatches mean the estimate's observed% disagrees with the script's independent parse."
  echo ">> common non-bug causes: same move name on BOTH sides (use disjoint damaging moves), or a"
  echo ">> verifier gap. A real divergence is a parser/inference bug worth chasing."
fi

echo
echo "=== backendIgnoredCount (unsupported/ignored events; investigate if nonzero) ==="
grep -oE '"backendIgnoredCount": [0-9]+' "$f" | sort -u || echo "(not present -- rebuild; data-hackmons-ignored-count attr added 2026-07-05)"

echo
echo "=== confidence histogram ==="
grep -oE 'Estimated Spread\\n(LOW|MEDIUM|HIGH)' "$f" | grep -oE '(LOW|MEDIUM|HIGH)' | sort | uniq -c || echo "(no estimates shown)"

echo
echo "=== inferred-nature histogram ==="
grep -oE 'Nature\\n[A-Za-z]+' "$f" | sort | uniq -c || echo "(no natures shown)"

echo
echo "=== final spreadVerification deltas (estimate vs real, %) ==="
awk '/Final custom Hackmons debug snapshot:/{g=1} g' "$f" | sed -n '/"deltas": {/,/^    }/p' || echo "(no spreadVerification -- estimate may not have appeared yet)"

echo
echo "=== final estimate event lines (observed vs modeled) ==="
# the estimate text is one JSON string with literal '\n' separators; expand them to real newlines
# so each "Turn N <move>: ..." diagnostic prints on its own line
awk '/Final custom Hackmons debug snapshot:/{g=1} g' "$f" \
  | sed 's/\\n/\n/g' \
  | grep -E '^Turn [0-9]+ .*delta [0-9.]+%' \
  | sort -u | head -12 || echo "(none)"
