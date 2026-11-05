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
#       App Store Connect for TestFlight. ASC_EXPORT_ONLY=1 stops at a signed .ipa in build/export.
#       ASC_SIGNING=manual signs with an Apple Distribution identity already in DREAM_SIGN_KEYCHAIN and the
#       App Store profiles named DREAM_PROFILE_APP and DREAM_PROFILE_WIDGET (the widget's bundle id is
#       DREAM_WIDGET_BUNDLE_ID, default <bundle id>.widget); testflight-namespace.ts sets these up.
#
#   On a Namespace Mac, with the key released by Dream's Worker: scripts/testflight-namespace.ts.
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
  sed -n '2,31p' "$0"; exit 2
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
# app.config.ts writes it into the app's Info.plist (CFBundleVersion); the widget takes CURRENT_PROJECT_VERSION.
# They have to match, and every upload needs a new one.
export BUILD_NUMBER="$build_number"

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
widget_bundle_id="${DREAM_WIDGET_BUNDLE_ID:-${DREAM_BUNDLE_ID:-build.omer.dream}.widget}"

if [[ "${ASC_SIGNING:-automatic}" == "manual" ]]; then
  : "${DREAM_PROFILE_APP:?set DREAM_PROFILE_APP}" "${DREAM_PROFILE_WIDGET:?set DREAM_PROFILE_WIDGET}"
  echo "› Signing manually with Apple Distribution (profiles \"$DREAM_PROFILE_APP\", \"$DREAM_PROFILE_WIDGET\")"
  # Per-target signing for the app and the widget (xcodebuild's command-line settings would hit every target,
  # Pods included). xcodeproj ships with CocoaPods.
  GEM_HOME="$(ls -d "$(brew --prefix 2>/dev/null || echo /opt/homebrew)"/Cellar/cocoapods/*/libexec 2>/dev/null | tail -n1)" \
  APP_ID="${DREAM_BUNDLE_ID:-build.omer.dream}" WIDGET_ID="$widget_bundle_id" \
  ruby -e '
    require "xcodeproj"
    project = Xcodeproj::Project.open(ARGV[0])
    profiles = { ENV["APP_ID"] => ENV["DREAM_PROFILE_APP"], ENV["WIDGET_ID"] => ENV["DREAM_PROFILE_WIDGET"] }
    signed = []
    project.targets.each do |target|
      target.build_configurations.each do |config|
        profile = profiles[config.build_settings["PRODUCT_BUNDLE_IDENTIFIER"]]
        next unless profile
        config.build_settings["CODE_SIGN_STYLE"] = "Manual"
        config.build_settings["CODE_SIGN_IDENTITY"] = "Apple Distribution"
        config.build_settings["CODE_SIGN_IDENTITY[sdk=iphoneos*]"] = "Apple Distribution"
        config.build_settings["PROVISIONING_PROFILE_SPECIFIER"] = profile
        config.build_settings["DEVELOPMENT_TEAM"] = ENV["DREAM_APPLE_TEAM_ID"]
        signed << "#{target.name}/#{config.name}" if config.name == "Release"
      end
    end
    abort "expected the app and the widget, signed: #{signed.inspect}" unless signed.size == 2
    project.save
    puts "› Manual signing for #{signed.join(", ")}"
  ' "$(ls -d "$app_dir"/ios/*.xcodeproj | head -n1)"
  archive_signing=(OTHER_CODE_SIGN_FLAGS="--keychain ${DREAM_SIGN_KEYCHAIN:?set DREAM_SIGN_KEYCHAIN}")
  export_signing="
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${DREAM_BUNDLE_ID:-build.omer.dream}</key><string>$DREAM_PROFILE_APP</string>
    <key>$widget_bundle_id</key><string>$DREAM_PROFILE_WIDGET</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>"
  # Exporting to a file needs no Apple account; uploading does.
  export_auth=()
  [[ -n "${ASC_EXPORT_ONLY:-}" ]] || export_auth=("${auth[@]}")
else
  archive_signing=(CODE_SIGN_STYLE=Automatic "${auth[@]}")
  export_signing="
  <key>signingStyle</key><string>automatic</string>"
  export_auth=("${auth[@]}")
fi

echo "› Archiving $scheme (build $build_number)"
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$build_dir/$scheme.xcarchive" \
  DEVELOPMENT_TEAM="$DREAM_APPLE_TEAM_ID" \
  CURRENT_PROJECT_VERSION="$build_number" \
  "${archive_signing[@]}" archive | (command -v xcbeautify >/dev/null && xcbeautify || cat)

cat > "$build_dir/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$([[ -n "${ASC_EXPORT_ONLY:-}" ]] && echo export || echo upload)</string>
  <key>teamID</key><string>$DREAM_APPLE_TEAM_ID</string>$export_signing
  <key>uploadSymbols</key><true/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict>
</plist>
PLIST

echo "› Exporting$([[ -n "${ASC_EXPORT_ONLY:-}" ]] || echo " and uploading to App Store Connect")"
xcodebuild -exportArchive -archivePath "$build_dir/$scheme.xcarchive" \
  -exportOptionsPlist "$build_dir/ExportOptions.plist" -exportPath "$build_dir/export" \
  ${export_auth[@]+"${export_auth[@]}"}

if [[ -n "${ASC_EXPORT_ONLY:-}" ]]; then
  ipa="$(ls "$build_dir"/export/*.ipa | head -n1)"
  echo "› Exported $ipa (not uploaded)"
  if [[ "${ASC_SIGNING:-automatic}" == "manual" ]]; then
    rm -rf "$build_dir/ipa-check" && mkdir -p "$build_dir/ipa-check" && (cd "$build_dir/ipa-check" && unzip -q "$ipa")
    for bundle in "$build_dir"/ipa-check/Payload/*.app "$build_dir"/ipa-check/Payload/*.app/PlugIns/*.appex; do
      codesign --verify --strict "$bundle" && echo "› $(basename "$bundle"): $(codesign -dvv "$bundle" 2>&1 | grep -m1 '^Authority=')," \
        "aps-environment $(codesign -d --entitlements :- "$bundle" 2>/dev/null | plutil -extract aps-environment raw -o - - 2>/dev/null || echo none)"
    done
  fi
  exit 0
fi

echo "› Uploaded build $build_number. It shows in TestFlight once App Store Connect finishes processing."
