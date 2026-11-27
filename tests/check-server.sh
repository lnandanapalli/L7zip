#!/usr/bin/env bash
# Checks the running container at $BASE (default http://localhost:8080):
# status codes, content types and security headers.
set -euo pipefail
BASE="${BASE:-http://localhost:8080}"
fail=0

# check <path> <expected status> <expected Content-Type prefix> [header regex...]
check() {
  local path="$1" status="$2" ctype="$3"; shift 3
  local bad=0 headers got_status got_ctype
  headers="$(curl -sS -D - -o /dev/null "$BASE$path" | tr -d '\r')"
  got_status="$(head -1 <<<"$headers" | awk '{print $2}')"
  got_ctype="$(grep -i '^content-type:' <<<"$headers" | head -1 | cut -d' ' -f2- || true)"
  if [[ "$got_status" != "$status" ]]; then echo "FAIL $path: status $got_status, want $status"; bad=1; fi
  if [[ "$got_ctype" != "$ctype"* ]]; then echo "FAIL $path: Content-Type '$got_ctype', want '$ctype'"; bad=1; fi
  if grep -qi '^content-disposition:' <<<"$headers"; then echo "FAIL $path: unexpected Content-Disposition"; bad=1; fi
  for re in "$@"; do
    grep -qiE "$re" <<<"$headers" || { echo "FAIL $path: missing header matching /$re/"; bad=1; }
  done
  if [[ $bad == 0 ]]; then echo "ok   $path"; else fail=1; fi
}

SEC=(
  '^x-content-type-options: nosniff$'
  '^referrer-policy: no-referrer$'
  '^x-frame-options: DENY$'
  '^cross-origin-opener-policy: same-origin$'
  '^strict-transport-security: max-age='
  '^cache-control: no-cache$'
)
PAGE_CSP="^content-security-policy: default-src 'self'.*connect-src 'none'"

check /                      200 text/html                  "${SEC[@]}" "$PAGE_CSP"
check /index.html            200 text/html                  "${SEC[@]}" "$PAGE_CSP"
check /app.js                200 application/javascript     "${SEC[@]}" "$PAGE_CSP"
check /styles.css            200 text/css                   "${SEC[@]}"
check /vendor/zip.min.js     200 application/javascript     "${SEC[@]}"
check /manifest.webmanifest  200 application/manifest+json  "${SEC[@]}" "$PAGE_CSP"
check /sw.js                 200 application/javascript     "${SEC[@]}" "^content-security-policy: default-src 'none'; connect-src 'self'$"
check /icons/icon-192.png    200 image/png
check /robots.txt            200 text/plain
check /does-not-exist        404 text/html

# No version number leaks in the Server header.
if curl -sSI "$BASE/" | tr -d '\r' | grep -qiE '^server: nginx/[0-9]'; then echo "FAIL: nginx version exposed"; fail=1; fi
[[ "$(curl -sS "$BASE/robots.txt")" == $'User-agent: *\nDisallow: /' ]] || { echo "FAIL: robots.txt body"; fail=1; }

exit $fail
