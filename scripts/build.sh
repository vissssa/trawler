#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${PROJECT_ROOT}/output"

echo "==> Cleaning previous build artifacts..."
rm -rf "${PROJECT_ROOT}/dist" "${OUTPUT_DIR}"

echo "==> Installing dependencies..."
cd "${PROJECT_ROOT}"
npm ci

echo "==> Compiling TypeScript..."
npx tsc

echo "==> Copying dist/ to output/..."
cp -r "${PROJECT_ROOT}/dist" "${OUTPUT_DIR}"

echo "==> Build complete. Output: ${OUTPUT_DIR}"
