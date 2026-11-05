#!/usr/bin/env bash
# Builds Dream's iPhone app on a Mac with Xcode: `expo prebuild`, CocoaPods, then
# xcodebuild. Run it from anywhere in the repo.
#
#   scripts/build-ios.sh simulator
#       Build for the iOS Simulator, unsigned. Prints the .app path. Release embeds
#       the JavaScript; CONFIGURATION=Debug makes a development build that loads it
#       from Metro (expo-dev-client).
#
#   scripts/build-ios.sh testflight --asc-key-path AuthKey_ABC123.p8 --asc-key-id ABC123 --asc-issuer-id <uuid>
#       Archives with automatic signing (Xcode creates or updates the App IDs and
#       profiles through the App Store Connect API key) and uploads the build to
#       App Store Connect for TestFlight.
#
# Environment (app.config.ts reads the DREAM_* values at prebuild):
#   DREAM_APPLE_TEAM_ID         default ZY6RS9293V (Dream's team)
#   DREAM_BUNDLE_ID             default build.omer.dream
#   DREAM_API_URL               default https://dream.omer.build
#   DREAM_BACKEND               default "live" here ("fixtures" runs the built-in sample world)
#   DREAM_GOOGLE_IOS_CLIENT_ID  default Dream's iOS client; enables Google sign-in
#   DREAM_APS_ENVIRONMENT       default "production" for testflight, "development" otherwise
#   BUILD_NUMBER                default: seconds since 2026-01-01, so every upload is unique
#   DEVELOPER_DIR               Xcode to use. Expo SDK 58 needs Xcode 26.4 or newer (older ones fail compiling
#                               expo-modules-jsi under Swift 6); by default the newest /Applications/Xcode_26.* that
#                               qualifies is picked, else the selected Xcode.
set -euo pipefail

mode="${1:-}"
shift || true
key_path="" key_id="" issuer_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --asc-key-path) key_path="$2"; shift 2 ;;
    --asc-key-id) key_id="$2"; shift 2 ;;
    --asc-issuer-id) issuer_id="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$mode" != "simulator" && "$mode" != "testflight" ]]; then
  sed -n '2,25p' "$0"; exit 2
fi

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
build_dir="$app_dir/build"
export DREAM_BACKEND="${DREAM_BACKEND:-live}"
# Dream's own Apple team and Google iOS client (public identifiers, not secrets).
export DREAM_APPLE_TEAM_ID="${DREAM_APPLE_TEAM_ID:-ZY6RS9293V}"
export DREAM_GOOGLE_IOS_CLIENT_ID="${DREAM_GOOGLE_IOS_CLIENT_ID:-83583994168-spbq6nhfhqv23uj17ua11kt9018k62gv.apps.googleusercontent.com}"
export DREAM_APS_ENVIRONMENT="${DREAM_APS_ENVIRONMENT:-$([[ $mode == testflight ]] && echo production || echo development)}"
build_number="${BUILD_NUMBER:-$(( $(date +%s) - 1767225600 ))}"

if [[ "$mode" == "testflight" ]]; then
  : "${DREAM_APPLE_TEAM_ID:?set DREAM_APPLE_TEAM_ID}"
  [[ -f "$key_path" && -n "$key_id" && -n "$issuer_id" ]] || {
    echo "testflight needs --asc-key-path (an existing .p8), --asc-key-id and --asc-issuer-id" >&2; exit 2; }
  key_path="$(cd "$(dirname "$key_path")" && pwd)/$(basename "$key_path")"
fi

if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  for xcode in $(ls -d /Applications/Xcode_26.*.app 2>/dev/null | sort -t. -k2 -n -r); do
    minor="$(basename "$xcode" .app | sed -E 's/Xcode_26\.([0-9]+).*/\1/')"
    if [[ "$minor" =~ ^[0-9]+$ && "$minor" -ge 4 ]]; then export DEVELOPER_DIR="$xcode/Contents/Developer"; break; fi
  done
fi
echo "› Using $(xcodebuild -version | head -n1)"

echo "› Installing dependencies"
(cd "$repo_root" && bun install --frozen-lockfile)

echo "› Generating the native project (backend: $DREAM_BACKEND)"
(cd "$app_dir" && CI=1 bunx expo prebuild --platform ios --clean --no-install)

echo "› Installing pods"
(cd "$app_dir/ios" && pod install)

workspace="$(ls -d "$app_dir"/ios/*.xcworkspace | head -n1)"
scheme="$(basename "$workspace" .xcworkspace)"
mkdir -p "$build_dir"

if [[ "$mode" == "simulator" ]]; then
  configuration="${CONFIGURATION:-Release}"
  echo "› Building $scheme ($configuration) for the iOS Simulator"
  # Signed ad hoc ("Sign to Run Locally"), so entitlements like the keychain apply in the Simulator.
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration "$configuration" \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$build_dir/derived" \
    CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM= \
    CURRENT_PROJECT_VERSION="$build_number" \
    build | (command -v xcbeautify >/dev/null && xcbeautify || cat)
  app="$(ls -d "$build_dir"/derived/Build/Products/"$configuration"-iphonesimulator/*.app | head -n1)"
  echo "› Built $app"
  exit 0
fi

auth=(-allowProvisioningUpdates
  -authenticationKeyPath "$key_path"
  -authenticationKeyID "$key_id"
  -authenticationKeyIssuerID "$issuer_id")

echo "› Archiving $scheme (build $build_number)"
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$build_dir/$scheme.xcarchive" \
  DEVELOPMENT_TEAM="$DREAM_APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$build_number" \
  "${auth[@]}" archive | (command -v xcbeautify >/dev/null && xcbeautify || cat)

cat > "$build_dir/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$DREAM_APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict>
</plist>
PLIST

echo "› Exporting and uploading to App Store Connect"
xcodebuild -exportArchive -archivePath "$build_dir/$scheme.xcarchive" \
  -exportOptionsPlist "$build_dir/ExportOptions.plist" -exportPath "$build_dir/export" \
  "${auth[@]}"

echo "› Uploaded build $build_number. It shows in TestFlight once App Store Connect finishes processing."
