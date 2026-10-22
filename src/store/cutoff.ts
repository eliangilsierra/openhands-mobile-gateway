/**
 * Returns the ISO timestamp `maxAgeMs` before `now`. Fails with an explicit `RangeError` when the
 * age is negative, not finite, or so large that the cutoff leaves the `Date` range, instead of
 * relying on `Date#toISOString` throwing a less specific error.
 */
export function cutoffIso(now: Date, maxAgeMs: number): string {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError("maxAgeMs must be a non-negative finite number");
  }
  const cutoff = new Date(now.getTime() - maxAgeMs);
  if (Number.isNaN(cutoff.getTime())) {
    throw new RangeError("maxAgeMs is too large: the cutoff would be outside the supported date range");
  }
  return cutoff.toISOString();
}
