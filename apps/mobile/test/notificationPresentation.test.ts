import { MessageId, NotificationId, ProjectId, PushData } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { showsWhileOpen } from "../src/data/notificationPresentation.ts"

const lift = ProjectId.make("prj_lift")
const cabin = ProjectId.make("prj_cabin")
const about = (projectId: ProjectId) =>
  Option.some(
    PushData.cases.OpenMessage.make({
      projectId,
      messageId: MessageId.make("msg_1"),
      notificationId: NotificationId.make("6f1c2a54-3b8e-4d2f-9a1e-0c5b7d9e2f41")
    })
  )

describe("showsWhileOpen", () => {
  it("stays quiet about the project whose screen is in front", () => {
    assert.isFalse(showsWhileOpen(about(lift), lift))
  })

  it("shows one about another project, or when no project is in front", () => {
    assert.isTrue(showsWhileOpen(about(cabin), lift))
    assert.isTrue(showsWhileOpen(about(cabin), undefined))
  })

  it("never shows a withdrawal, and shows what it can't read", () => {
    const withdraw = Option.some(
      PushData.cases.Withdraw.make({ notificationIds: [NotificationId.make("6f1c2a54-3b8e-4d2f-9a1e-0c5b7d9e2f41")] })
    )
    assert.isFalse(showsWhileOpen(withdraw, undefined))
    assert.isTrue(showsWhileOpen(Option.none(), lift))
  })
})
