#!/usr/bin/env bash
# The install script and the updater, for real, on this machine. No browser, and nothing outside a temporary folder but the CLI's own dist.
# Builds linux-x64 or darwin bundles with a throwaway key, using the Node you have, then installs them from a local folder and updates over loopback.
# Usage: dev/e2e/e2e-install.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
T=$(mktemp -d "${TMPDIR:-/tmp}/ar-install.XXXXXX")
SERVER=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
  rm -rf "$T"
  # The bundles were built with the throwaway key.
  pnpm -s -C "$REPO/packages/cli" build >/dev/null 2>&1
}
trap cleanup EXIT

fails=0
check() {
  if [ "$1" = 0 ]; then echo "  ok    $2"; else echo "  FAIL  $2"; fails=$((fails + 1)); fi
}
yes_if() { "$@" >/dev/null 2>&1; echo $?; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64) TARGET=linux-arm64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  *) echo "No target for this machine"; exit 1 ;;
esac

node -e "const {generateKeyPairSync:g}=require('crypto');const f=require('fs');for(const n of ['key','other']){f.writeFileSync('$T/'+n+'.pem',g('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))}"
NOW=$(node -p "require('./package.json').version")
echo "Building bundles"
node releases/scripts/bundle.mjs --only "$TARGET" --node "$(command -v node)" --key "$T/key.pem" --out "$T/now" >/dev/null || { echo "Bundle failed"; exit 1; }
node releases/scripts/bundle.mjs --only "$TARGET" --node "$(command -v node)" --key "$T/key.pem" --out "$T/next" --as 99.0.0 >/dev/null || { echo "Bundle failed"; exit 1; }

export HOME="$T/home"
unset XDG_BIN_HOME AGENTIC_ROUTINES_HOME AGENTIC_ROUTINES_SESSION AGENTIC_ROUTINES_NO_UPDATE
mkdir -p "$HOME"
APP="$HOME/.agentic-routines/app"
CMD="$HOME/.local/bin/agentic-routines"
install_from() { AGENTIC_ROUTINES_BASE="file://$1" sh "$REPO/apps/site/public/install" --no-setup </dev/null 2>&1; }

echo "Refuses a bad download"
cp -r "$T/now" "$T/tampered"
printf x >>"$T/tampered/agentic-routines-$NOW-$TARGET.tar.gz"
out=$(install_from "$T/tampered"); [ $? != 0 ] && echo "$out" | grep -q "wrong size"; check $? "a file of the wrong size is refused"
[ ! -e "$APP/current.txt" ]; check $? "and nothing is installed"
sed -E -i.bak 's/"sha256":"[0-9a-f]{8}/"sha256":"00000000/' "$T/tampered/manifest.json"
node -e "const f=require('fs'),p='$T/tampered/agentic-routines-$NOW-$TARGET.tar.gz';f.writeFileSync(p,f.readFileSync(p).subarray(0,-1))"
out=$(install_from "$T/tampered"); [ $? != 0 ] && echo "$out" | grep -q "checksum"; check $? "a file with another checksum is refused"
[ ! -e "$APP/current.txt" ] && [ ! -e "$CMD" ]; check $? "and nothing is installed"

echo "Installs"
out=$(install_from "$T/now"); check $? "the install script finishes"
echo "$out" | sed 's/^/        /'
[ "$(cat "$APP/current.txt")" = "$NOW" ]; check $? "current.txt names $NOW"
[ -x "$CMD" ]; check $? "the command is there"
! ls -a "$APP" | grep -q '^\.install'; check $? "and no temporary folder is left"
"$CMD" update status </dev/null | grep -q "from the install script"; check $? "it knows it came from the install script"
# Doctor exits 1 here, as no browser is connected.
doctor=$("$CMD" doctor </dev/null 2>&1)
echo "$doctor" | grep -q "This copy.*from the install script"; check $? "doctor says so too"
echo "$doctor" | grep -q "Playwright.*there"; check $? "the bundle can load Playwright"
[ -f "$APP/$NOW/node_modules/agentic-routines/dist/execute-worker.js" ] && ! echo "$doctor" | grep -q "Execute"; check $? "and has the worker for execute"
echo "$doctor" | grep -q "Updates.*by itself when idle"; check $? "a build with a key says it updates by itself"
echo "$doctor" | grep -q "Commands.*tools are commands"; check $? "and doctor counts the commands"
"$CMD" tools </dev/null | grep -q '^navigate'; check $? "the tools are commands"

"$CMD" setup --agent claude-code </dev/null >/dev/null 2>&1
grep -q "$APP/run" "$HOME/.claude.json" 2>/dev/null; check $? "setup points an agent at the launcher, not at one version"
grep -q "$APP/run" "$HOME/.agentic-routines/bin/host" 2>/dev/null; check $? "and the native host too"
"$HOME/.agentic-routines/bin/host" help </dev/null >/dev/null 2>&1; check $? "which starts"

echo "Updates"
out=$("$CMD" update off </dev/null 2>&1); [ $? != 0 ] && echo "$out" | grep -q "in a terminal"; check $? "without a terminal, the setting stays as it is"

SERVE=$T/serve
mkdir -p "$SERVE"
node -e "
const http=require('http'),fs=require('fs'),path=require('path');
const s=http.createServer((q,a)=>{const f=path.join('$SERVE',path.basename(q.url));fs.readFile(f,(e,b)=>{a.statusCode=e?404:200;a.end(e?'':b)})});
s.listen(0,'127.0.0.1',()=>fs.writeFileSync('$T/port',String(s.address().port)));
" &
SERVER=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
export AGENTIC_ROUTINES_BASE="http://127.0.0.1:$(cat "$T/port")"

cp "$T/now"/* "$SERVE/"
"$CMD" update </dev/null | grep -q "Up to date"; check $? "the same version changes nothing"

cp "$T/next"/* "$SERVE/"
node -e "
const {sign,createPrivateKey}=require('crypto'),f=require('fs');
f.writeFileSync('$SERVE/manifest.sig',sign(null,f.readFileSync('$SERVE/manifest.json'),createPrivateKey(f.readFileSync('$T/other.pem'))).toString('base64'));"
out=$("$CMD" update </dev/null 2>&1); [ $? != 0 ] && echo "$out" | grep -q "signature"; check $? "a manifest signed by another key is refused"
[ "$(cat "$APP/current.txt")" = "$NOW" ]; check $? "and the version stays"
"$CMD" update status </dev/null | grep -q "it failed"; check $? "status says it failed"

rm "$SERVE/manifest.sig"
out=$("$CMD" update </dev/null 2>&1); [ $? != 0 ]; check $? "a manifest with no signature is refused"

cp "$T/next/manifest.sig" "$SERVE/manifest.sig"
printf x >>"$SERVE/agentic-routines-99.0.0-$TARGET.tar.gz"
out=$("$CMD" update </dev/null 2>&1); [ $? != 0 ] && echo "$out" | grep -q "does not match"; check $? "a signed manifest and a file that does not match is refused"
[ "$(cat "$APP/current.txt")" = "$NOW" ]; check $? "and the version stays"

cp "$T/next"/* "$SERVE/"
out=$("$CMD" update </dev/null 2>&1); echo "$out" | grep -q "Updated"; check $? "the real one is installed: $out"
[ "$(cat "$APP/current.txt")" = 99.0.0 ]; check $? "current.txt moves on"
"$CMD" update status </dev/null | grep -q "Version 99.0.0"; check $? "the command now runs the new version"
"$HOME/.agentic-routines/bin/host" help </dev/null >/dev/null 2>&1; check $? "and so does the native host"
[ -d "$APP/$NOW" ]; check $? "the one that was running stays, for what still has it open"

cp "$T/now"/* "$SERVE/"
"$CMD" update </dev/null >/dev/null 2>&1
[ "$(cat "$APP/current.txt")" = 99.0.0 ]; check $? "a signed older version is not taken"

echo "A copy that is not installed leaves itself alone"
(cd "$REPO" && node packages/cli/dist/index.js update </dev/null) | grep -q "did not come from the install script"; check $? "a checkout does not update itself"

echo
if [ "$fails" = 0 ]; then echo "All passed"; else echo "$fails failed"; exit 1; fi
