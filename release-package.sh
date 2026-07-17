#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="code-usage@gnome-extensions.local"
VERSION="modern-v1"
DIST_DIR="dist"
STAGING_DIR="$DIST_DIR/$EXT_UUID"
ARCHIVE_NAME="code-usage-extension-$VERSION.zip"

command -v glib-compile-schemas >/dev/null 2>&1 || {
  echo "ERROR: glib-compile-schemas not found" >&2
  exit 1
}

command -v zip >/dev/null 2>&1 || {
  echo "ERROR: zip not found" >&2
  exit 1
}

rm -rf "$DIST_DIR"
mkdir -p "$STAGING_DIR/modules" "$STAGING_DIR/worker" "$STAGING_DIR/icons" "$STAGING_DIR/schemas"

cp extension.js "$STAGING_DIR/"
cp prefs.js "$STAGING_DIR/"
cp stylesheet.css "$STAGING_DIR/"
cp metadata.json "$STAGING_DIR/"
cp install.sh "$STAGING_DIR/"
cp LICENSE "$STAGING_DIR/"
cp README_RELEASE.md "$STAGING_DIR/README.md"

cp modules/*.js "$STAGING_DIR/modules/"
cp worker/*.js "$STAGING_DIR/worker/"
cp icons/* "$STAGING_DIR/icons/"
cp schemas/org.gnome.shell.extensions.code-usage.gschema.xml "$STAGING_DIR/schemas/"

glib-compile-schemas "$STAGING_DIR/schemas"

(
  cd "$DIST_DIR"
  zip -qr "$ARCHIVE_NAME" "$EXT_UUID"
)

echo "Created $DIST_DIR/$ARCHIVE_NAME"
