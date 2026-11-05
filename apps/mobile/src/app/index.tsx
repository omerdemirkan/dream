import * as Fixtures from "@dream/domain/fixtures"
import { DateTime, Effect, Schema } from "effect"
import { Message } from "@dream/domain"
import { Text, View } from "react-native"

const encoded = Schema.encodeSync(Schema.toCodecJson(Message))(Fixtures.cabinQuestion)
const roundTrip = Schema.decodeUnknownSync(Schema.toCodecJson(Message))(JSON.parse(JSON.stringify(encoded)))
const now = Effect.runSync(DateTime.now)

export default function Home() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0C" }}>
      <Text style={{ color: "white" }}>{roundTrip._tag === "Question" ? roundTrip.question : "?"}</Text>
      <Text style={{ color: "gray" }}>{DateTime.formatIso(now)}</Text>
    </View>
  )
}
