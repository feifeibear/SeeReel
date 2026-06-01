#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run verify:canvas-crud
