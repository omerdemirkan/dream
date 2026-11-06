/**
 * Home with no projects (mocks/screens/home-empty, A3): "What should exist?" in a hand-lettered face, and a
 * hand-drawn loop-de-loop down to the input. It sits where the list would end, just above the input, and draws
 * itself in once when it appears: the words fade in, the stroke runs from them to the input, then the head lands.
 * With Reduce Motion it's simply there.
 */
import { useFonts } from "expo-font"
import { useEffect } from "react"
import { View } from "react-native"
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming
} from "react-native-reanimated"
import Svg, { Defs, G, Mask, Path } from "react-native-svg"
import { arrowArt, arrowBox } from "./handArrow.ts"
import { color } from "./theme.ts"

const AnimatedPath = Animated.createAnimatedComponent(Path)
const AnimatedG = Animated.createAnimatedComponent(G)

const handFont = "GochiHand"
/** The drawing at a little under full size, so the tip stops short of the input. */
const scale = 0.85
/** How far above the input the tip stops. */
const tipGap = 28

export function EmptyInvite() {
  const [loaded, error] = useFonts({ [handFont]: require("../../assets/fonts/GochiHand-Regular.ttf") })
  // A moment's wait for a bundled font; if it can't load, the system face says the same thing.
  if (!loaded && !error) return null
  return <Drawing hand={loaded} />
}

function Drawing(props: { readonly hand: boolean }) {
  const still = useReducedMotion()
  const words = useSharedValue(still ? 1 : 0)
  const stroke = useSharedValue(still ? 1 : 0)
  const head = useSharedValue(still ? 1 : 0)
  useEffect(() => {
    if (still) return
    words.value = withTiming(1, { duration: 320 })
    stroke.value = withDelay(220, withTiming(1, { duration: 760, easing: Easing.out(Easing.cubic) }))
    head.value = withDelay(940, withTiming(1, { duration: 180 }))
  }, [still, words, stroke, head])

  const wordsStyle = useAnimatedStyle(() => ({ opacity: words.value }))
  const reveal = useAnimatedProps(() => ({ strokeDashoffset: arrowArt.length * (1 - stroke.value) }))
  const headProps = useAnimatedProps(() => ({ opacity: head.value }))

  return (
    <View
      pointerEvents="none"
      // The tip stops tipGap above the input; the list's padding leaves 22.
      style={{ alignItems: "center", marginBottom: tipGap - 22 - scale * (arrowBox.height - arrowArt.tip[1]) }}
    >
      <Animated.Text
        maxFontSizeMultiplier={1.3}
        style={[
          {
            fontFamily: props.hand ? handFont : undefined,
            fontSize: props.hand ? 23 : 19,
            color: color.ink,
            marginBottom: 3
          },
          wordsStyle
        ]}
      >
        What should exist?
      </Animated.Text>
      <Svg
        width={arrowBox.width * scale}
        height={arrowBox.height * scale}
        viewBox={`0 0 ${arrowBox.width} ${arrowBox.height}`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Defs>
          {/* The shaft is a tapered shape, so a stroke along its centre line uncovers it as it draws. */}
          <Mask id="draw" maskUnits="userSpaceOnUse" x={0} y={0} width={arrowBox.width} height={arrowBox.height}>
            <AnimatedPath
              d={arrowArt.centre}
              fill="none"
              stroke="#fff"
              strokeWidth={6}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={[arrowArt.length, arrowArt.length]}
              animatedProps={reveal}
            />
          </Mask>
        </Defs>
        <Path d={arrowArt.shaft} fill={color.inkLine} mask="url(#draw)" />
        <AnimatedG animatedProps={headProps}>
          {arrowArt.barbs.map((d) => (
            <Path key={d} d={d} fill={color.inkLine} />
          ))}
        </AnimatedG>
      </Svg>
    </View>
  )
}
