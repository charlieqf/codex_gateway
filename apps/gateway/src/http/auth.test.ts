import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { devAuthHook } from "./auth.js";
import {
  researchRouteConfig,
  type GatewayRequestContext
} from "./context.js";

describe("gateway auth response dialect", () => {
  it("uses the Research envelope for authentication failures", async () => {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request, reply) =>
      devAuthHook(request, reply, {
        accessToken: "secret",
        context: {} as GatewayRequestContext
      })
    );
    app.get(
      "/research-test",
      { config: researchRouteConfig },
      async () => ({ ok: true })
    );

    const response = await app.inject({
      method: "GET",
      url: "/research-test"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      schema_version: "doctor_research_error.v1",
      request_id: response.headers["x-request-id"] ?? response.json().request_id,
      error: {
        code: "missing_credential",
        message: "Missing access credential."
      }
    });
    expect(response.json().request_id).toMatch(/^req-/);
    await app.close();
  });
});
