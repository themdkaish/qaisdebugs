/**
 * The wall clock, as it was when the agent loaded.
 *
 * Next 15+ with Cache Components replaces `Date.now` while it prerenders a route and reports any
 * call made during a render ("encountered the unstable value `Date.now()`"). The agent stamps
 * events from inside those renders (an axios call or a `console.log` in a Server Component), so
 * it keeps its own reference, taken at preload before Next patches anything. Timestamps never
 * reach the rendered output, so this changes nothing about what the page renders.
 */
const pristineNow = Date.now;

export function wallClock(): number {
  return pristineNow.call(Date);
}
