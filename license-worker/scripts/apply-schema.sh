#!/usr/bin/env bash
# Apply the Harmony license worker schema to the configured D1 database.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
wrangler d1 execute harmony-license --file=schema/001_initial.sql "$@"
wrangler d1 execute harmony-license --file=schema/002_seed_pa.sql "$@"
echo "Schema applied."
