import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ResearchDockerContractTests(unittest.TestCase):
    def test_non_root_runtime_can_read_gateway_and_research_entrypoints(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        copy_apps = dockerfile.index(
            "COPY --from=build /app/apps /app/apps"
        )
        copy_packages = dockerfile.index(
            "COPY --from=build /app/packages /app/packages"
        )
        readable_workspace = dockerfile.index(
            "chmod -R a=rX /app/apps /app/packages"
        )
        non_root_user = dockerfile.index("USER codexgw")
        gateway_probe = dockerfile.index(
            "test -r /app/apps/gateway/dist/index.js"
        )
        worker_probe = dockerfile.index(
            "test -r /app/apps/research-worker/dist/index.js"
        )
        maintenance_probe = dockerfile.index(
            "test -r /app/apps/research-worker/dist/maintenance-index.js"
        )
        fixture_probe = dockerfile.index(
            "test -r /app/packages/core/src/fixtures/"
            "phase0.5-compatibility.v1.json"
        )

        self.assertLess(copy_apps, readable_workspace)
        self.assertLess(copy_packages, readable_workspace)
        self.assertLess(readable_workspace, non_root_user)
        self.assertLess(non_root_user, gateway_probe)
        self.assertLess(gateway_probe, worker_probe)
        self.assertLess(worker_probe, maintenance_probe)
        self.assertLess(maintenance_probe, fixture_probe)

    def test_runtime_keeps_workspace_code_non_writable(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn("chmod -R a=rX /app/apps /app/packages", dockerfile)
        self.assertNotIn(
            "chown -R codexgw:codexgw /app/apps",
            dockerfile,
        )
        self.assertNotIn(
            "chown -R codexgw:codexgw /app/packages",
            dockerfile,
        )


if __name__ == "__main__":
    unittest.main()
