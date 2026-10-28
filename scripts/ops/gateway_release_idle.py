"""Wait for a quiet release window while keeping admission open."""
import time


def validate_lifecycle(value):
    if not isinstance(value, dict) or type(value.get("draining")) is not bool:
        raise RuntimeError("Runtime has no drain protocol; signal was not sent")
    if any(type(value.get(key)) is not int or value[key] < 0
           for key in ("active_requests", "active_work")):
        raise RuntimeError("Invalid Gateway lifecycle counters; production unchanged")
    return value


def wait_for_natural_idle(status, *, timeout=900, stable_seconds=30,
                          monotonic=time.monotonic, sleep=time.sleep):
    if timeout <= 0 or stable_seconds <= 0 or stable_seconds >= timeout:
        raise ValueError("Invalid release idle window")
    until = monotonic() + timeout
    idle_since = None
    while monotonic() < until:
        lifecycle = validate_lifecycle(status())
        if lifecycle.get("draining") is not False:
            raise RuntimeError("Gateway is already draining; inspect before release")
        counts = [lifecycle.get(key) for key in ("active_requests", "active_work")]
        now = monotonic()
        if now >= until:
            break
        if counts == [0, 0]:
            if idle_since is None:
                idle_since = now
            if now - idle_since >= stable_seconds:
                return
        else:
            idle_since = None
        sleep(min(2, max(0, until - monotonic())))
    raise RuntimeError("No 30-second natural idle window; production unchanged")
