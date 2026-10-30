#!/usr/bin/env bash
# Builds this public website payload without deploying or changing its hostnames.
set -euo pipefail
cd "$(dirname "$0")/.."
export ASTRO_TELEMETRY_DISABLED=1
bun - <<'JSCI'
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
let json=0,syntax=0;
for(const path of files){
  if(path.endsWith('.json')){JSON.parse(readFileSync(path,'utf8'));json++;}
  if(/\.(?:mjs|js)$/.test(path) && !path.startsWith('public/vendor/')){new Bun.Transpiler({loader:'js'}).transformSync(readFileSync(path,'utf8'));syntax++;}
}
if(!json || !syntax) throw new Error('Source validation coverage unexpectedly empty');
console.log(`Validated ${json} JSON inputs and ${syntax} JavaScript/config sources.`);
JSCI
bun install --frozen-lockfile
bun run build
test -s dist/index.html
test -s dist/sv/index.html
bun audit --audit-level high
printf '%s\n' 'Public website build, English/Swedish entry pages and dependency audit passed.'
