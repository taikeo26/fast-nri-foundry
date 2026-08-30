import assert from "node:assert/strict";
import { calculateHpBarLayout } from "../module/token-visuals.mjs";

const close = (actual, expected, epsilon = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} ≈ ${expected}`
  );
};

function assertLayout(input, expected) {
  const result = calculateHpBarLayout(input);
  close(result.green, expected.green);
  close(result.gap, expected.gap);
  close(result.blue, expected.blue);
  close(result.green + result.gap + result.blue, 1);
}

// No temp: ordinary max HP alone is 100%.
assertLayout(
  { value: 60, max: 100, temp: 0 },
  { green: 0.6, gap: 0.4, blue: 0 }
);

// Canonical combined total:
// max 100 + temp 20 = total 120.
// current 60 = 50%; missing 40 = 33.333%; temp 20 = 16.667%.
assertLayout(
  { value: 60, max: 100, temp: 20 },
  { green: 0.5, gap: 1 / 3, blue: 1 / 6 }
);

// Full normal HP + temp: green and blue touch.
assertLayout(
  { value: 100, max: 100, temp: 20 },
  { green: 5 / 6, gap: 0, blue: 1 / 6 }
);

// 100 normal max + 100 temp => each contributes half of total visual max.
assertLayout(
  { value: 60, max: 100, temp: 100 },
  { green: 0.3, gap: 0.2, blue: 0.5 }
);

// Large temp would be 75% naturally, but visual cap limits blue to 70%.
// The ordinary HP ratio 60/100 is preserved inside the remaining 30%.
assertLayout(
  { value: 60, max: 100, temp: 300 },
  { green: 0.18, gap: 0.12, blue: 0.70 }
);

console.log("hp-bar-layout-regression: OK");
