import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("stats", pathlib.Path(__file__).with_name("vision-repeat-stats.py"))
stats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stats)


def row(message="one", scope="session", ids=("a",), scope_id="s", fingerprints=True, attempts=None):
    observation = {"scannedImageCount": len(ids), "completeness": "complete", "duplicateWireEntryCount": 0}
    if fingerprints:
        observation["fingerprints"] = {"version": 1, "keyId": "key", "keySource": "r2-derived", "scope": scope,
            "scopeId": scope_id, "omittedEntries": 0, "entries": [
                {"id": value, "source": "content", "inLastUserMessage": False} for value in ids]}
    return {"vision_observation_json": json.dumps(observation), "client_message_id": message,
        "upstream_runtime": "tiankuan", "upstream_attempt_count": len(attempts or []),
        "upstream_attempts_json": json.dumps(attempts or []),
        **dict.fromkeys(("prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_prompt_tokens", "total_tokens"), 10)}


class StatsTest(unittest.TestCase):
    def test_partition_and_retry_evidence(self):
        report = stats.summarize([row(ids=("a", "a")), row(), row("two", attempts=[
            {"purpose": "primary", "visionRecovery": {"imageCount": 1}},
            {"purpose": "failure_retry", "inputImageCount": 1}]), row(scope_id="other")])
        counts = report["counts"]
        self.assertEqual(counts["within_request_repeated_entries"], 1)
        self.assertEqual(counts["cross_request_repeated_identities"], 2)
        self.assertEqual(counts["first_seen_identities_in_window"], 2)
        self.assertEqual(counts["repeats_with_same_client_message_id"], 1)
        self.assertEqual(counts["repeats_with_different_client_message_id"], 1)
        self.assertEqual(counts["attempted_image_entries_failure_retry"], 1)
        self.assertEqual(report["providers"]["tiankuan"]["total_tokens"], 40)

    def test_unknowns_are_not_zeros_or_new_uploads(self):
        counts = stats.summarize([row(fingerprints=False), row(scope="request"), row(), row(message=None)])['counts']
        self.assertEqual(counts["requests_missing_fingerprints"], 1)
        self.assertEqual(counts["requests_without_session_scope"], 1)
        self.assertEqual(counts["first_seen_identities_in_window"], 1)
        self.assertEqual(counts["repeats_without_message_id"], 1)


if __name__ == "__main__":
    unittest.main()
