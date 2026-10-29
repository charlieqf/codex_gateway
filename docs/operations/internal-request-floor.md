# Internal Plan daily request floor

Internal daily request benefits belong to the live Plan, in
`metadata.requestRateFloor.requestsPerDay`. Authentication reads the current
Plan of the active, scope-compatible entitlement for both `cgw` and `cgu` keys.
Effective RPD is the larger of the credential's RPD and the Plan floor.
An unlimited credential remains unlimited. Expired, paused, cancelled, future
or out-of-scope grants do not confer the benefit.

This benefit applies to existing and future grants without credential rewrites
or entitlement snapshot migrations. Token policies, minute limits, concurrency
and UTC reset boundaries are unchanged. Counters retain their existing
per-credential identity; changing the Plan while the service runs preserves
the counter. The existing in-memory counters reset on a Gateway restart.

After deploying a runtime supporting the benefit, preview and apply the
authorized internal minimum of 1,000 through the guarded wrapper:

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- raise-internal-request-floor "<reason>"
python scripts/manage-r760-gateway-control.py -- raise-internal-request-floor "<reason>" <preview-revision>
```

The operation explicitly covers the five current internal templates: standard,
standard with images, elevated with images, 100m/day with images, and the internal
Desktop test Plan. It preserves a higher existing Plan floor. The reviewed hash
guards the entire selected Plan rows. After a verified online backup, one
transaction changes only Plan metadata and records its before/after images in
the admin audit log. Credential policies, entitlement snapshots and usage are
not edited. Audit failures roll back the transaction. Verify both public
`/gateway/credentials/current` rates and the all-internal cohort afterward,
including the accounts outside any input spreadsheet.

New internal templates must explicitly set this metadata; do not derive a
benefit from a display name or an untrusted client-provided classification.
