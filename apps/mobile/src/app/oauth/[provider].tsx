/**
 * Where the API's callback for any other OAuth provider sends the browser back to:
 * dream://oauth/<provider>?status=connected|error&projectId=…&messageId=…[&error=…]
 * Like `google.tsx`: the access message updates over the live stream; this lands in the
 * project's Chat on that message.
 */
import { MessageId, ProjectId } from "@dream/domain"
import { useAtomSet } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { Redirect, useLocalSearchParams } from "expo-router"
import { useEffect } from "react"
import { landingAtom } from "../../state/ui.ts"
import { useToast } from "../../ui/actions.ts"

export default function OAuthReturn() {
  const params = useLocalSearchParams<{
    provider?: string
    status?: string
    projectId?: string
    messageId?: string
    error?: string
  }>()
  const projectId = Option.getOrUndefined(Schema.decodeUnknownOption(ProjectId)(params.projectId))
  const messageId = Option.getOrUndefined(Schema.decodeUnknownOption(MessageId)(params.messageId))
  const setLanding = useAtomSet(landingAtom)
  const toast = useToast()
  const service = params.provider ? params.provider.charAt(0).toUpperCase() + params.provider.slice(1) : "It"
  useEffect(() => {
    if (params.status === "error") toast(`${service} didn't connect: ${params.error ?? "try again"}.`)
    if (projectId && messageId) setLanding(Option.some({ projectId, messageId, highlight: true, at: Date.now() }))
  }, [params.status, params.error, service, projectId, messageId, setLanding, toast])
  return projectId ? (
    <Redirect href={{ pathname: "/project/[id]", params: { id: projectId, tab: "chat" } }} />
  ) : (
    <Redirect href="/" />
  )
}
