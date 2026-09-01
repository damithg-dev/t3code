import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Provider rate-limit reset timestamps arrive as bare epoch numbers, and
 * neither Claude nor Codex documents whether they are seconds or milliseconds.
 * Adapters normalize them here before putting them on the wire.
 */

// 1e11 seconds lands in the year 5138 while 1e11 milliseconds lands in 1973,
// so anything above the threshold can only sensibly be read as milliseconds.
const MILLISECOND_EPOCH_THRESHOLD = 1e11;

/** ISO string for a provider-reported epoch, or null when it is unusable. */
export function rateLimitResetToIso(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const millis = value > MILLISECOND_EPOCH_THRESHOLD ? value : value * 1_000;
  return Option.match(DateTime.make(millis), {
    onNone: () => null,
    onSome: (instant) => DateTime.formatIso(instant),
  });
}
