/**
 * Dream's own native module (ios/DreamNativeModule.swift): Live Activity tokens
 * from ActivityKit, and launch arguments. Absent where it isn't built in
 * (tests, Expo Go).
 */
import { type EventSubscription, requireOptionalNativeModule } from "expo"

export interface ActivityToken {
  readonly activityId: string
  readonly projectId: string
  readonly token: string
}

export interface DreamNativeModule {
  /** A `-key value` launch argument (the Simulator's `simctl launch … -key value`). */
  launchArgument(key: string): string | null
  areActivitiesEnabled(): boolean
  startObserving(): void
  /** Starts an activity on this phone (fixtures mode); returns its id. Arguments are JSON. */
  startLocal(attributes: string, content: string): Promise<string>
  endAll(): Promise<void>
  addListener(event: "onPushToStartToken", listener: (event: { readonly token: string }) => void): EventSubscription
  addListener(event: "onActivityToken", listener: (event: ActivityToken) => void): EventSubscription
  addListener(
    event: "onActivityEnded",
    listener: (event: { readonly activityId: string; readonly projectId: string }) => void
  ): EventSubscription
}

export const DreamNative = requireOptionalNativeModule<DreamNativeModule>("DreamNative")
