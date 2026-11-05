/**
 * Live Activity tokens from ActivityKit (see ios/DreamLiveActivityModule.swift).
 * Absent where the native module isn't built in (tests, Expo Go).
 */
import { type EventSubscription, requireOptionalNativeModule } from "expo"

export interface ActivityToken {
  readonly activityId: string
  readonly projectId: string
  readonly token: string
}

export interface DreamLiveActivityModule {
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

export const DreamLiveActivity = requireOptionalNativeModule<DreamLiveActivityModule>("DreamLiveActivity")
