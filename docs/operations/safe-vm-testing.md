# Former Shared-Azure VM Testing Archive

Status: retired from routine Gateway testing.

This document previously described safe testing for the shared Azure VM and
the `codex_gateway_test` project. Current Gateway testing belongs on R760 and
must follow [Environment Access](./environment-access.md) and the relevant
task runbook from the [Runbook Index](./runbook-index.md).

Do not start the retired Azure Gateway, install or reconfigure Docker, or
change shared-host Nginx/firewall settings as part of a current smoke test.
Historical commands remain in Git history for separately authorized recovery
or shared-host maintenance only.
