"""Read-only image-repeat/attempt statistics. Run on R760 with --db and --since (UTC ISO).

Counts observed equality, not unnecessary work. The window is left-censored:
first-seen means first seen inside this query window, not a new user upload.
No image fingerprints, subjects, message IDs, content or URLs are printed.
"""
import argparse
import collections
import datetime
import json
import pathlib
import sqlite3


def summarize(rows):
    counts = collections.Counter()
    providers = {}
    seen = set()
    seen_messages = set()
    key_ids = set()
    for row in rows:
        try:
            observation = json.loads(row["vision_observation_json"] or "null") or {}
        except (ValueError, TypeError):
            observation = {}
        if not observation.get("scannedImageCount", 0):
            continue
        counts["requests_with_images"] += 1
        counts["scanned_image_entries"] += observation["scannedImageCount"]
        counts["incomplete_scan_requests"] += observation.get("completeness") != "complete"
        counts["exact_url_detail_duplicates"] += observation.get("duplicateWireEntryCount") or 0
        fingerprint = observation.get("fingerprints")
        if fingerprint and fingerprint.get("version") == 1:
            counts["requests_with_fingerprints"] += 1
            counts["omitted_fingerprint_entries"] += fingerprint.get("omittedEntries", 0)
            key_ids.add(fingerprint["keyId"])
            session_scope = fingerprint.get("scope") == "session"
            counts["requests_without_session_scope"] += not session_scope
            counts["requests_with_process_only_key"] += fingerprint.get("keySource") == "process"
            current = set()
            outside = {entry["id"] for entry in fingerprint["entries"] if not entry["inLastUserMessage"]}
            for entry in fingerprint["entries"]:
                identity = (fingerprint["keyId"], fingerprint["scopeId"], entry["id"])
                counts["fingerprinted_entries"] += 1
                counts["identity_source_" + entry["source"]] += 1
                if identity in current:
                    counts["within_request_repeated_entries"] += 1
                    continue
                current.add(identity)
                if not session_scope:
                    counts["cross_request_unclassifiable_identities"] += 1
                    continue
                if identity in seen:
                    counts["cross_request_repeated_identities"] += 1
                    counts["repeated_identities_outside_last_user_message"] += entry["id"] in outside
                    message = row["client_message_id"]
                    if not message:
                        counts["repeats_without_message_id"] += 1
                    elif (identity, message) in seen_messages:
                        counts["repeats_with_same_client_message_id"] += 1
                    else:
                        counts["repeats_with_different_client_message_id"] += 1
                else:
                    counts["first_seen_identities_in_window"] += 1
            # Update after the request so internal duplicates cannot count as history.
            if session_scope:
                seen.update(current)
                if row["client_message_id"]:
                    seen_messages.update((identity, row["client_message_id"]) for identity in current)
        else:
            counts["requests_missing_fingerprints"] += 1
        provider = row["upstream_runtime"] or "unrouted"
        p = providers.setdefault(provider, collections.Counter())
        p["requests"] += 1
        p["upstream_attempts"] += row["upstream_attempt_count"] or 0
        p["requests_missing_usage"] += row["total_tokens"] is None
        for column in ("prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_prompt_tokens", "total_tokens"):
            p[column] += row[column] or 0
        try:
            attempts = json.loads(row["upstream_attempts_json"] or "[]")
        except (ValueError, TypeError):
            attempts = []
        for attempt in attempts:
            purpose = attempt.get("purpose")
            if purpose not in ("primary", "failure_retry", "contract_recovery"):
                purpose = "unclassified"
            counts["provider_attempts_" + purpose] += 1
            image_count = attempt.get("inputImageCount", (attempt.get("visionRecovery") or {}).get("imageCount"))
            if isinstance(image_count, int) and image_count >= 0:
                counts["attempted_image_entries_" + purpose] += image_count
            else:
                counts["provider_attempts_without_image_count"] += 1
    # Stable zero-valued fields make absence distinguishable from an older report.
    for name in ("requests_with_images", "requests_with_fingerprints", "requests_missing_fingerprints",
                 "within_request_repeated_entries", "cross_request_repeated_identities",
                 "repeats_with_same_client_message_id", "repeats_with_different_client_message_id",
                 "repeats_without_message_id", "requests_without_session_scope", "omitted_fingerprint_entries",
                 "provider_attempts_failure_retry", "provider_attempts_contract_recovery"):
        counts.setdefault(name, 0)
    return {"counts": dict(counts), "fingerprint_key_generations": len(key_ids),
            "providers": {k: dict(v) for k, v in providers.items()}, "limitations": [
                "First-seen is limited to the selected time window; old events have no fingerprints.",
                "Same-message repeats may be tool continuations or client retries; they are not proof of waste.",
                "URL equality is asset/URL identity, not verified image bytes; reuploads and inline/URL matches are not joined.",
                "Provider attempts do not prove successful upload or billing; tokens include the entire image-bearing request."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", default=datetime.datetime.now(datetime.timezone.utc).isoformat())
    args = parser.parse_args()
    def iso(value):
        dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            parser.error("Times must include a timezone")
        return dt.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    since, until = iso(args.since), iso(args.until)
    if since >= until:
        parser.error("--since must precede --until")
    with sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        db.row_factory = sqlite3.Row
        rows = db.execute("""SELECT vision_observation_json, client_message_id, upstream_runtime,
            upstream_attempt_count, upstream_attempts_json, prompt_tokens, completion_tokens,
            reasoning_tokens, cached_prompt_tokens, total_tokens FROM request_events
            WHERE started_at >= ? AND started_at < ? AND vision_observation_json IS NOT NULL
            ORDER BY started_at, request_id""", (since, until))
        report = summarize(rows)
    print(json.dumps({"since": since, "until": until, **report}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
