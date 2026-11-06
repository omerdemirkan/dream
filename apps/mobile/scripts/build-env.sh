# The DREAM_* settings a build is made with, by kind, for app.config.ts. Sourced by build-ios.sh, and by
# updates.ts so an over-the-air update is exported with the same config (and so the same runtime version) as the
# builds it's for. Values already in the environment win.
#
#   . scripts/build-env.sh testflight|simulator
#
#   DREAM_APPLE_TEAM_ID         default ZY6RS9293V (Dream's team)
#   DREAM_BUNDLE_ID             default build.omer.dream
#   DREAM_API_URL               default https://dream.omer.build
#   DREAM_BACKEND               default "live" here ("fixtures" runs the built-in sample world)
#   DREAM_GOOGLE_IOS_CLIENT_ID  default Dream's iOS client; enables Google sign-in
#   DREAM_APS_ENVIRONMENT       default "production" for testflight, "development" otherwise
#   DREAM_UPDATES_CHANNEL       default "production" for testflight, "fixtures" with the fixtures backend,
#                               "development" otherwise (the over-the-air update channel the build follows)
#   DREAM_UPDATES_ENABLED       "1" gives a simulator build over-the-air updates; testflight builds always have them
export DREAM_BACKEND="${DREAM_BACKEND:-live}"
# Dream's own Apple team and Google iOS client (public identifiers, not secrets).
export DREAM_APPLE_TEAM_ID="${DREAM_APPLE_TEAM_ID:-ZY6RS9293V}"
export DREAM_GOOGLE_IOS_CLIENT_ID="${DREAM_GOOGLE_IOS_CLIENT_ID:-83583994168-spbq6nhfhqv23uj17ua11kt9018k62gv.apps.googleusercontent.com}"
export DREAM_APS_ENVIRONMENT="${DREAM_APS_ENVIRONMENT:-$([[ ${1:-} == testflight ]] && echo production || echo development)}"
if [[ -z "${DREAM_UPDATES_CHANNEL:-}" ]]; then
  if [[ "$DREAM_APS_ENVIRONMENT" == production ]]; then DREAM_UPDATES_CHANNEL=production
  elif [[ "$DREAM_BACKEND" == fixtures ]]; then DREAM_UPDATES_CHANNEL=fixtures
  else DREAM_UPDATES_CHANNEL=development; fi
fi
export DREAM_UPDATES_CHANNEL
# The native project is generated (`expo prebuild --clean`, ios/ is gitignored), so the runtime version fingerprints
# what generates it. Said outright because expo-updates otherwise asks git, and a `git archive` checkout (the
# Namespace build Mac) has none: it would count ios/ in and get a runtime version no publish computes.
export EXPO_UPDATES_WORKFLOW_OVERRIDE=managed
