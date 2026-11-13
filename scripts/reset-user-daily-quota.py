#!/usr/bin/env python3
"""Reset one user's daily Token usage through the live R760 Billing API."""
import argparse
import json
import re
import sys
from pathlib import Path

from gateway_state_sync import SyncError, default_r760_gateway, run_ssh, shell_word


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phone", help="Mainland mobile number, optionally prefixed with +86")
    parser.add_argument("--what-if", action="store_true", help="Read the target and daily usage only")
    parser.add_argument("--reason", default="Operator requested daily Token quota reset")
    args = parser.parse_args()
    phone = args.phone.removeprefix("+86")
    if not re.fullmatch(r"1[3-9][0-9]{9}", phone):
        parser.error("Expected a mainland mobile number")
    if not args.reason.strip() or len(args.reason) > 500:
        parser.error("Reason must contain 1–500 characters")
    endpoint = default_r760_gateway()
    operation = {"phone": phone, "apply": not args.what_if, "reason": args.reason}
    source = "globalThis.operation = " + json.dumps(operation) + ";\n"
    source += Path(__file__).with_name("gateway-user-daily-quota-reset.cjs").read_text(encoding="utf-8")
    result = run_ssh(endpoint, f"docker exec -i -w /app {shell_word(endpoint.container)} node -",
                     stdin=source, timeout_seconds=50)
    print(json.dumps(json.loads(result.stdout), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SyncError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
