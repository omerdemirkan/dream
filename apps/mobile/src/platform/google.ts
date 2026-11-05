/**
 * Native Google Sign-In (@react-native-google-signin, the free "original" API),
 * wrapped once as an Effect. The ID token goes to the API's `SignIn`, which
 * checks it against Google's keys and the invite list.
 *
 * Its audience is the iOS client id, or the web client id when
 * DREAM_GOOGLE_WEB_CLIENT_ID is set (then the API can verify one audience for
 * every platform).
 */
import { Data, Effect, Option } from "effect"
import { TurboModuleRegistry } from "react-native"
import { appConfig } from "../state/runtime.ts"

export class GoogleSignInError extends Data.TaggedError("GoogleSignInError")<{ readonly message: string }> {}

/** Configured for this build and linked into the binary. */
export const googleSignInAvailable =
  appConfig.googleIosClientId !== undefined && TurboModuleRegistry.get("RNGoogleSignin") !== null

/** The ID token from Google's sign-in sheet, or none if they cancelled. */
export const googleIdToken: Effect.Effect<Option.Option<string>, GoogleSignInError> = Effect.gen(function* () {
  if (!googleSignInAvailable || !appConfig.googleIosClientId) {
    return yield* new GoogleSignInError({ message: "Google sign-in isn't set up in this build." })
  }
  const iosClientId = appConfig.googleIosClientId
  // Loaded lazily: importing the package needs its native module.
  const { GoogleSignin, isSuccessResponse } = yield* Effect.promise(
    () => import("@react-native-google-signin/google-signin")
  )
  GoogleSignin.configure({
    iosClientId,
    ...(appConfig.googleWebClientId ? { webClientId: appConfig.googleWebClientId } : {}),
    scopes: ["email", "profile"]
  })
  const response = yield* Effect.tryPromise({
    try: () => GoogleSignin.signIn(),
    catch: (cause) =>
      new GoogleSignInError({ message: cause instanceof Error ? cause.message : "Google sign-in didn't finish." })
  })
  if (!isSuccessResponse(response)) return Option.none()
  const token = response.data.idToken
  if (!token) return yield* new GoogleSignInError({ message: "Google didn't return an ID token." })
  return Option.some(token)
})
