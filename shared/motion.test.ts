import { describe, expect, it } from 'vitest';
import { snapDamped, stepDamped, type Damped } from './motion.ts';

const at = (value: number): Damped => ({ value, velocity: 0 });

// One 200ms step, the cadence a walking entity actually arrives at.
const STEP_DT = 0.2;

describe('stepDamped', () => {
  it('converges on the target without ever overshooting it', () => {
    const s = at(0);
    let last = 0;
    for (let i = 0; i < 200; i++) {
      stepDamped(s, 1, 0.12, 1 / 60);
      expect(s.value).toBeLessThanOrEqual(1);
      expect(s.value).toBeGreaterThanOrEqual(last);
      last = s.value;
    }
    expect(s.value).toBe(1);
  });

  it('settles exactly rather than approaching forever', () => {
    const s = at(0);
    for (let i = 0; i < 500; i++) stepDamped(s, 5, 0.12, 1 / 60);
    expect(s.value).toBe(5);
    expect(s.velocity).toBe(0);
  });

  it('stays stable under a huge dt instead of exploding', () => {
    // A backgrounded tab resuming: the cubic approximation has to hold up.
    const s = at(0);
    stepDamped(s, 10, 0.12, 30);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(s.value).toBeGreaterThanOrEqual(0);
    expect(s.value).toBeLessThanOrEqual(10);
  });

  it('carries velocity across successive steps', () => {
    // This is the whole reason for a spring over a lerp: after the first jump
    // has built up speed, the second is met with motion already in progress, so
    // an uneven arrival cadence comes out smoother than it went in.
    const fresh = at(0);
    stepDamped(fresh, 1, 0.12, 1 / 60);
    const fromRest = fresh.value;

    const moving = at(0);
    for (let i = 0; i < 12; i++) stepDamped(moving, 1, 0.12, 1 / 60);
    const before = moving.value;
    stepDamped(moving, 2, 0.12, 1 / 60);   // target jumps again mid-flight
    expect(moving.value - before).toBeGreaterThan(fromRest);
  });

  it('lags further behind with a longer smoothTime', () => {
    const tight = at(0), floaty = at(0);
    stepDamped(tight, 1, 0.08, STEP_DT);
    stepDamped(floaty, 1, 0.30, STEP_DT);
    expect(tight.value).toBeGreaterThan(floaty.value);
  });

  it('tracks a moving target without falling permanently behind', () => {
    // A walk is a target that advances one tile every ~200ms forever. The
    // follower must reach a steady lag, not drift away without bound.
    const s = at(0);
    let target = 0;
    const lags: number[] = [];
    for (let step = 0; step < 40; step++) {
      target += 1;
      for (let f = 0; f < 12; f++) stepDamped(s, target, 0.12, STEP_DT / 12);
      lags.push(target - s.value);
    }
    expect(lags.at(-1)!).toBeLessThan(1);
    expect(lags.at(-1)!).toBeCloseTo(lags[20]!, 3);
  });
});

describe('snapDamped', () => {
  it('cuts to the target and kills the motion', () => {
    const s = { value: 3, velocity: 40 };
    snapDamped(s, -2);
    expect(s).toEqual({ value: -2, velocity: 0 });
  });
});
