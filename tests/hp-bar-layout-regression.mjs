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

// No temporary HP: ordinary HP uses the whole bar.
assertLayout(
  { value: 60, max: 100, temp: 0 },
  { green: 0.6, gap: 0.4, blue: 0 }
);

// Ordinary example: max 100 + temp 20 = visual total 120.
assertLayout(
  { value: 60, max: 100, temp: 20 },
  { green: 0.5, gap: 1 / 3, blue: 1 / 6 }
);

// Full HP + temp: green and blue touch, no missing-HP gap.
assertLayout(
  { value: 100, max: 100, temp: 20 },
  { green: 5 / 6, gap: 0, blue: 1 / 6 }
);

// Very large temp HP: blue is capped at 70%; ordinary max gets 30%.
assertLayout(
  { value: 60, max: 100, temp: 300 },
  { green: 0.18, gap: 0.12, blue: 0.70 }
);

// Cap still preserves missing-HP ratio within the 30% ordinary span.
assertLayout(
  { value: 50, max: 100, temp: 1000 },
  { green: 0.15, gap: 0.15, blue: 0.70 }
);

console.log("hp-bar-layout-regression: OK");
