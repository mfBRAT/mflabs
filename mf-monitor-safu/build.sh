#!/bin/bash
# =============================================================================
# build.sh — Build BTCWalletMonitor.app for macOS
# =============================================================================
# Prerequisites:
#   brew install python@3.13 python-tk@3.13
#   pip3.13 install pyinstaller websockets requests --break-system-packages
#
# Run:
#   chmod +x build.sh
#   ./build.sh
# =============================================================================

set -e

PYTHON="python3.13"
APP_NAME="BTCWalletMonitor"
DIST_DIR="dist"
ZIP_NAME="${APP_NAME}.zip"

echo ""
echo "══════════════════════════════════════════"
echo "  Building ${APP_NAME}.app"
echo "══════════════════════════════════════════"
echo ""

# Check pyinstaller is available
if ! $PYTHON -m PyInstaller --version &>/dev/null; then
    echo "❌  PyInstaller not found. Install with:"
    echo "    pip3.13 install pyinstaller --break-system-packages"
    exit 1
fi

# Clean previous builds
echo "🧹  Cleaning previous builds..."
rm -rf build dist __pycache__

# Build
echo "🔨  Running PyInstaller..."
$PYTHON -m PyInstaller btc_monitor.spec

# Check it worked
if [ ! -d "${DIST_DIR}/${APP_NAME}.app" ]; then
    echo "❌  Build failed — .app not found in dist/"
    exit 1
fi

# Zip for distribution
echo "📦  Zipping for distribution..."
cd "${DIST_DIR}"
zip -r "../${ZIP_NAME}" "${APP_NAME}.app"
cd ..

echo ""
echo "══════════════════════════════════════════"
echo "  ✅  Done!"
echo ""
echo "  App:  dist/${APP_NAME}.app"
echo "  Zip:  ${ZIP_NAME}  ← share this"
echo "══════════════════════════════════════════"
echo ""
echo "  To run immediately:"
echo "  open dist/${APP_NAME}.app"
echo ""
