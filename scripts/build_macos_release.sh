#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64|x64) ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 2 ;;
esac

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="DeepSeekDesktop"
BUILD_DIR="dist/${APP_NAME}-darwin-${ARCH}"
APP_PATH="${BUILD_DIR}/${APP_NAME}.app"
ARTIFACT_DIR="release"
BASE_NAME="${APP_NAME}-${VERSION}-macos-${ARCH}"

rm -rf "$BUILD_DIR"
mkdir -p "$ARTIFACT_DIR"

npx electron-packager . "$APP_NAME" \
  --platform=darwin \
  --arch="$ARCH" \
  --overwrite \
  --asar \
  --app-bundle-id=com.ds.desktop \
  --app-version="$VERSION" \
  --icon=assets/icon.icns \
  --out=dist \
  --download.cacheRoot=.electron-cache \
  --ignore='^/(\.electron-cache|npm-cache|scripts|\.gitignore|\.npmrc|dist|release)(/|$)'

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  codesign --deep --force --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$APP_PATH"
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
fi

rm -f "${ARTIFACT_DIR}/${BASE_NAME}.zip" "${ARTIFACT_DIR}/${BASE_NAME}.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "${ARTIFACT_DIR}/${BASE_NAME}.zip"

DMG_STAGE="$(mktemp -d)"
trap 'rm -rf "$DMG_STAGE"' EXIT
cp -R "$APP_PATH" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "DeepSeek Desktop" -srcfolder "$DMG_STAGE" \
  -ov -format UDZO "${ARTIFACT_DIR}/${BASE_NAME}.dmg"

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" \
    "${ARTIFACT_DIR}/${BASE_NAME}.dmg"
fi

if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  xcrun notarytool submit "${ARTIFACT_DIR}/${BASE_NAME}.dmg" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "${ARTIFACT_DIR}/${BASE_NAME}.dmg"
fi

shasum -a 256 \
  "${ARTIFACT_DIR}/${BASE_NAME}.dmg" \
  "${ARTIFACT_DIR}/${BASE_NAME}.zip" \
  > "${ARTIFACT_DIR}/${BASE_NAME}.sha256"

echo "Created release artifacts in ${ARTIFACT_DIR}/"
