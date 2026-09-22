import type { VisionObservationSnapshot } from "@codex-gateway/core";

/**
 * Accumulates structural facts about wire image entries while a request is parsed.
 *
 * The parser fills one of these as it scans, so whichever return path fires -
 * success, an image rejection mid-scan, or an unrelated rejection afterwards -
 * the caller already holds counts consistent with how far the scan got. That
 * removes the need to decorate every early return, and keeps the snapshot off
 * the error object, where generic error/Pino serialization could carry it out.
 */
export interface VisionObservation {
  /** Set once the message/input loop begins; until then the body never reached scanning. */
  scanning: boolean;
  /** Set once the loop finished without rejecting, before the image limit checks run. */
  scanned: boolean;
  /** Index of the last wire container seen with role=user, images or not. */
  lastUserContainer: number | null;
  entries: Array<{
    /** Index of the wire message (Chat) or input item (Responses) carrying this entry. */
    container: number;
    url: string;
    detail?: string;
  }>;
}

export function beginVisionObservation(): VisionObservation {
  return { scanning: false, scanned: false, lastUserContainer: null, entries: [] };
}

/**
 * Mark that the container loop was entered, before any per-container validation.
 * Setting this later would report the same class of rejection as `unavailable` when
 * the first container is malformed but `partial` when a later one is.
 */
export function beginVisionScan(observation: VisionObservation | undefined): void {
  if (observation) observation.scanning = true;
}

/** Record every container's role, so `user` position is known even when it carried no image. */
export function noteVisionContainer(
  observation: VisionObservation | undefined,
  container: number,
  role: string
): void {
  if (observation && role === "user") observation.lastUserContainer = container;
}

export function noteVisionImage(
  observation: VisionObservation | undefined,
  container: number | undefined,
  url: string,
  detail?: string
): void {
  if (!observation || container === undefined) return;
  observation.entries.push({ container, url, ...(detail ? { detail } : {}) });
}

export function visionObservationSnapshot(
  observation: VisionObservation
): VisionObservationSnapshot {
  const scannedImageCount = observation.entries.length;
  if (!observation.scanned) {
    return {
      completeness: observation.scanning ? "partial" : "unavailable",
      scannedImageCount,
      wireImageCount: null,
      imagesInLastUserMessage: null,
      imagesOutsideLastUserMessage: null,
      lastUserMessagePresent: null,
      detailCounts: null,
      duplicateWireEntryCount: null
    };
  }

  const { lastUserContainer } = observation;
  const detailCounts = { high: 0, low: 0, auto: 0, unspecified: 0 };
  // Keyed by the url string already held by the request, then by detail. Concatenating
  // the two into one key would allocate a fresh copy of every inline data URL.
  const distinctByUrl = new Map<string, Set<string>>();
  let distinctCount = 0;
  let inside = 0;
  for (const entry of observation.entries) {
    if (entry.detail === "high") detailCounts.high += 1;
    else if (entry.detail === "low") detailCounts.low += 1;
    else if (entry.detail === "auto") detailCounts.auto += 1;
    else detailCounts.unspecified += 1;
    let details = distinctByUrl.get(entry.url);
    if (!details) {
      details = new Set<string>();
      distinctByUrl.set(entry.url, details);
    }
    const key = entry.detail ?? "";
    if (!details.has(key)) {
      details.add(key);
      distinctCount += 1;
    }
    if (lastUserContainer !== null && entry.container === lastUserContainer) inside += 1;
  }

  return {
    completeness: "complete",
    scannedImageCount,
    wireImageCount: scannedImageCount,
    imagesInLastUserMessage: inside,
    imagesOutsideLastUserMessage: scannedImageCount - inside,
    lastUserMessagePresent: lastUserContainer !== null,
    detailCounts,
    duplicateWireEntryCount: scannedImageCount - distinctCount
  };
}
