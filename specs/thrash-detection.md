# Spec — Thrash detection

## What

When Ralph keeps Ralphing the wrong thing — same files modified with the
same failure 3+ iterations in a row — Ralpharium surfaces it as a thrash
alert so the user can pause and fix the prompt instead of burning tokens.

## Detection rule

`controller.detect_thrash(window=6, repeat_threshold=3)` scans the most
recent `window` iterations and returns `thrashing: true` if any of:

1. `repeat_threshold` or more consecutive iterations failed.
2. The same file appears in `files_changed` of `repeat_threshold` or more
   recent failures.
3. The same `failure_reason` repeats `repeat_threshold` or more times.

## Surfaces

- `GET /api/thrash` → JSON snapshot.
- Included in `controller.aggregate()` so the dashboard sees it on
  first paint.
- RAM page renders a red "Thrash detected" card above Memory pressure
  when `thrashing: true`, listing repeated files + reasons.

## Acceptance

- 3 consecutive `git commit --allow-empty` failures produce a thrash
  alert (consecutive_failures ≥ 3).
- Mixing one passing iteration into 3 failures resets the counter.
- The card is hidden when `thrashing: false`.
