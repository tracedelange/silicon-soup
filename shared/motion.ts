// Critically damped spring smoothing, shared by everything that has to follow a
// value that only ever arrives in discrete jumps.
//
// The world is tick-quantized: positions land on whole tiles on whole 100ms
// server ticks, via a fractional accumulator, so the input cadence is uneven by
// construction (roughly 200ms per step with an occasional 100ms catch-up). A
// plain exponential lerp restarts from zero velocity on every jump and
// re-radiates that unevenness as a visible surge-rest-surge bounce. A spring
// carries velocity across jumps, which low-passes the irregular input into
// near-constant motion — and stays smooth whatever the walk rate is tuned to.
//
// This is the standard SmoothDamp formulation. The cubic is a stable rational
// approximation of e^-x, so it cannot overshoot or ring however large dt gets —
// which is what makes it safe to feed the long dt of a backgrounded tab.

/** A value being eased toward a target, plus the velocity that carries across
 *  jumps. Mutated in place: this runs per entity per frame and returning a
 *  fresh object was measurable. */
export interface Damped {
  value: number;
  velocity: number;
}

/** How close (in the value's own units) counts as arrived. Asymptotic approach
 *  never quite gets there, which otherwise leaves things nudging by sub-pixel
 *  amounts forever while standing still. */
const SETTLE_VALUE = 0.002;
const SETTLE_VELOCITY = 0.01;

/** Advance `s` toward `target` by `dt` seconds. `smoothTime` is roughly the
 *  time to converge: lower is tighter, higher is floatier. */
export function stepDamped(s: Damped, target: number, smoothTime: number, dt: number): void {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.value - target;
  const tmp = (s.velocity + omega * change) * dt;
  s.velocity = (s.velocity - omega * tmp) * decay;
  s.value = target + (change + tmp) * decay;
  if (Math.abs(target - s.value) < SETTLE_VALUE && Math.abs(s.velocity) < SETTLE_VELOCITY) {
    s.value = target;
    s.velocity = 0;
  }
}

/** Drop `s` onto `target` with no motion — for a discontinuity that should cut
 *  rather than pan (a portal, a respawn, a blink, an entity appearing). */
export function snapDamped(s: Damped, target: number): void {
  s.value = target;
  s.velocity = 0;
}
