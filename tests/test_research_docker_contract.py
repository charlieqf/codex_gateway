import pathlib
import json
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
        readable_package = dockerfile.index(
            "chmod 0444 /app/package.json"
        )
        non_root_user = dockerfile.index("USER codexgw")
        package_probe = dockerfile.index("test -r /app/package.json")
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
        self.assertLess(readable_package, non_root_user)
        self.assertLess(readable_workspace, non_root_user)
        self.assertLess(non_root_user, package_probe)
        self.assertLess(package_probe, gateway_probe)
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

    def test_staging_compose_is_loopback_only_and_uses_isolated_state(self):
        compose = (ROOT / "compose.research-staging.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            '"127.0.0.1:${RESEARCH_STAGING_PORT:-18788}:8787"',
            compose,
        )
        self.assertIn(
            "research_staging_state:/var/lib/codex-gateway-research",
            compose,
        )
        self.assertIn(
            "research_staging_backups:/var/lib/codex-gateway-research-backups",
            compose,
        )
        self.assertNotIn("network_mode: host", compose)

    def test_staging_compose_uses_direct_goldencode_without_proxy_secrets(self):
        compose = (ROOT / "compose.research-staging.yml").read_text(
            encoding="utf-8"
        )
        registry = json.loads(
            (
                ROOT / "config" / "research.staging.goldencode.example.json"
            ).read_text(encoding="utf-8")
        )

        model = registry["goldencode"]
        members = model["pool"]["members"]
        self.assertTrue(model["pool"]["requireAllMembers"])
        self.assertEqual(
            [(member["runtime"], member["upstreamModel"]) for member in members],
            [
                ("qianfan", "glm-5.2"),
                ("tencent", "glm-5.2"),
                ("aliyun", "glm-5.2"),
            ],
        )
        self.assertNotIn("research_web_search_api_key", compose)
        self.assertNotIn("research_orcid_client_secret", compose)
        self.assertNotIn("openrouter", json.dumps(registry).lower())
        self.assertNotIn('"runtime": "codex"', json.dumps(registry).lower())

    def test_production_overlay_is_default_closed_and_uses_separate_state(self):
        compose = (ROOT / "compose.research-production.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "RESEARCH_API_ENABLED: ${RESEARCH_PRODUCTION_API_ENABLED:-false}",
            compose,
        )
        self.assertIn(
            "RESEARCH_WORKER_ENABLED: ${RESEARCH_PRODUCTION_WORKER_ENABLED:-false}",
            compose,
        )
        self.assertIn(
            "RESEARCH_API_ENABLED: "
            "${RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED:-false}",
            compose,
        )
        self.assertIn(
            "RESEARCH_MAINTENANCE_ENABLED: ${RESEARCH_PRODUCTION_MAINTENANCE_ENABLED:-false}",
            compose,
        )
        self.assertIn(
            "research_production_state:/var/lib/codex-gateway-research",
            compose,
        )
        self.assertIn(
            "research_production_backups:/var/lib/codex-gateway-research-backups",
            compose,
        )
        self.assertIn(
            "research_production_llm_gateway_state:/var/lib/codex-gateway",
            compose,
        )
        self.assertNotIn("network_mode: host", compose)
        self.assertNotIn("ports:", compose)

    def test_production_research_llm_pool_is_direct_goldencode_only(self):
        registry = json.loads(
            (
                ROOT / "config" / "research.production.goldencode.example.json"
            ).read_text(encoding="utf-8")
        )
        model = registry["goldencode"]
        members = model["pool"]["members"]

        self.assertTrue(model["pool"]["requireAllMembers"])
        self.assertEqual(
            [(member["runtime"], member["upstreamModel"]) for member in members],
            [
                ("qianfan", "glm-5.2"),
                ("tencent", "glm-5.2"),
                ("aliyun", "glm-5.2"),
            ],
        )
        self.assertEqual(
            {
                member["runtime"]: (
                    member["enabled"],
                    member["maxConcurrent"],
                )
                for member in members
            },
            {
                "qianfan": (False, 1),
                "tencent": (False, 1),
                "aliyun": (True, 3),
            },
        )
        serialized = json.dumps(registry).lower()
        self.assertNotIn("openrouter", serialized)
        self.assertNotIn('"runtime": "codex"', serialized)

    def test_production_examples_fail_closed_without_operator_values(self):
        worker = (
            ROOT / "config" / "research.production.worker.example.env"
        ).read_text(encoding="utf-8")
        compose_environment = (
            ROOT / "config" / "research.production.compose.example.env"
        ).read_text(encoding="utf-8")
        llm_gateway = (
            ROOT / "config" / "research.production.llm-gateway.example.env"
        ).read_text(encoding="utf-8")

        self.assertIn("RESEARCH_PRODUCTION_API_ENABLED=false", compose_environment)
        self.assertIn(
            "RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED=false",
            compose_environment,
        )
        self.assertIn(
            "RESEARCH_PRODUCTION_WORKER_ENABLED=false",
            compose_environment,
        )
        self.assertIn(
            "RESEARCH_PRODUCTION_MAINTENANCE_ENABLED=false",
            compose_environment,
        )
        self.assertIn("RESEARCH_WORKER_ENABLED=false", worker)
        self.assertIn(
            "RESEARCH_BACKUP_TARGET_ENCRYPTION_CONFIRMED=false",
            worker,
        )
        self.assertIn("RESEARCH_ORCID_MODE=disabled", worker)
        self.assertIn("replace-with-production-operator", worker)
        self.assertIn(
            "GATEWAY_API_KEY_ENCRYPTION_SECRET=replace-with-",
            llm_gateway,
        )
        self.assertNotIn("sk-", worker)
        self.assertNotIn("sk-", llm_gateway)

    def test_live_smoke_case_is_an_allowlisted_direct_profile(self):
        request = json.loads(
            (
                ROOT / "config" / "research.staging.request.example.json"
            ).read_text(encoding="utf-8")
        )

        self.assertEqual(request["doctor"]["name"], "Shen Baiyong")
        self.assertEqual(request["doctor"]["hospital"], "Ruijin Hospital")
        self.assertEqual(request["doctor"]["department"], "Surgery")
        self.assertEqual(
            request["doctor"]["official_profile_urls"],
            ["https://www.shsmu.edu.cn/english/info/1336/2980.htm"],
        )
        self.assertNotIn("model", request)
        self.assertNotIn("outputs", request)

    def test_production_identity_registry_is_versioned_and_image_bound(self):
        registry_path = (
            ROOT
            / "config"
            / "research.official-identity-registry.v1.json"
        )
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        compose = (ROOT / "compose.research-production.yml").read_text(
            encoding="utf-8"
        )
        api_example_env = (
            ROOT / "config" / "research.production.api.example.env"
        ).read_text(encoding="utf-8")

        self.assertEqual(
            registry["schema_version"],
            "doctor_research_official_identity_registry.v1",
        )
        self.assertEqual(len(registry["entries"]), 1)
        self.assertEqual(
            {
                key: registry["entries"][0][key]
                for key in ("name", "hospital", "department")
            },
            {
                "name": "陆清声",
                "hospital": "海军军医大学第一附属医院",
                "department": "血管外科",
            },
        )
        self.assertEqual(
            registry["entries"][0]["literature_identity"]["name"],
            "Lu Qingsheng",
        )
        self.assertIn(
            "COPY config/research.official-identity-registry.v1.json ",
            dockerfile,
        )
        self.assertIn(
            "test -r /app/config/research.official-identity-registry.v1.json",
            dockerfile,
        )
        self.assertIn(
            "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH: "
            "/app/config/research.official-identity-registry.v1.json",
            compose,
        )
        self.assertNotIn(
            "RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON=",
            api_example_env,
        )


if __name__ == "__main__":
    unittest.main()
