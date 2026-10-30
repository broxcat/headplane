#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --input-type=module -e '
import fs from "node:fs";
import cp from "node:child_process";
const tools=JSON.parse(fs.readFileSync("release/toolchains.json","utf8"));
if(process.version!==`v${tools.node}` || cp.execFileSync("pnpm",["--version"],{encoding:"utf8"}).trim()!==tools.pnpm || cp.execFileSync("go",["env","GOVERSION"],{encoding:"utf8"}).trim()!==`go${tools.go}`) throw Error("Use the exact toolchains in release/toolchains.json");
'
export CGO_ENABLED=0
export GOFLAGS="-trimpath -buildvcs=false"
export GOOS=linux
export GOARCH=amd64
export GOAMD64=v1
./build.sh --wasm --agent --healthcheck --agent-output .cache/guest-bin/hp_agent --healthcheck-output .cache/guest-bin/hp_healthcheck
export HEADPLANE_VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
export HEADPLANE_GUEST_PACKAGE=1
pnpm build
node scripts/guest-release.ts package "v$HEADPLANE_VERSION" "${1:-dist}"
