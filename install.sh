#!/usr/bin/env bash

EXT_UUID="code-usage@gnome-extensions.local"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "Installing code-usage-extension..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR/extension.js" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/metadata.json" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/prefs.js" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/stylesheet.css" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/modules" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/icons" "$INSTALL_DIR/"
mkdir -p "$INSTALL_DIR/schemas"
cp -r "$SCRIPT_DIR/schemas/org.gnome.shell.extensions.code-usage.gschema.xml" "$INSTALL_DIR/schemas/"

cd "$INSTALL_DIR/schemas"
glib-compile-schemas .

echo "Extension installed to: $INSTALL_DIR"
echo ""

# Check for optional sqlite3 dependency
if command -v sqlite3 &>/dev/null; then
    echo "sqlite3: found (required for OpenCode, Goose, Hermes, Kilo)"
else
    echo "WARNING: sqlite3 not found. OpenCode/Goose/Hermes/Kilo agents require sqlite3 CLI."
    echo "  Install with: sudo apt install sqlite3  (or your distro's equivalent)"
fi
echo ""
echo "To enable the extension:"
echo "  1. Restart GNOME Shell (Alt+F2, type 'r', press Enter) or log out and log back in"
echo "  2. Enable the extension using: gnome-extensions enable $EXT_UUID"
echo ""
echo "Or use Extensions app (gnome-extensions-app) to toggle it."