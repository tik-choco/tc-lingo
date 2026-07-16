// Direction-aware panel switching: given an ordered set of tab ids and the
// active one, reports which way the user moved so the incoming panel can
// slide in from that side (see the .pane-enter classes in index.css).
//
// The result is remembered per activation — unrelated re-renders while the
// enter animation is still playing keep returning the same direction, so the
// animation class never flips mid-flight.
import { useRef } from "preact/hooks";

export type EnterDirection = "none" | "from-left" | "from-right";

export function useEnterDirection<T>(order: readonly T[], active: T): EnterDirection {
  const state = useRef<{ active: T; dir: EnterDirection } | null>(null);
  if (state.current === null) {
    // First render: appear in place, no slide.
    state.current = { active, dir: "none" };
  } else if (state.current.active !== active) {
    const from = order.indexOf(state.current.active);
    const to = order.indexOf(active);
    const dir: EnterDirection =
      from < 0 || to < 0 || from === to ? "none" : to > from ? "from-right" : "from-left";
    state.current = { active, dir };
  }
  return state.current.dir;
}

/** Class string for the enter wrapper. Pair with key={active} so Preact
 * remounts the wrapper (restarting the animation) on every switch. */
export function paneEnterClass(dir: EnterDirection): string {
  return dir === "none" ? "pane-enter" : `pane-enter pane-enter--${dir}`;
}
