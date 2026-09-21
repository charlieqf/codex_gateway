import type { FastifyServerOptions, FastifyRequest } from "fastify";

const assetPath = "/gateway/vision/assets";

/** Logging only: never use this tolerant path matching for routing or admission. */
function assetLogUrl(url: string | undefined): string | null {
  const path = (url ?? "").split(/[?#]/u, 1)[0]!
    .replace(/^https?:\/\/[^/]+/iu, "")
    // Decode ASCII escapes without failing on a malformed asset parameter.
    .replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  // Even unmatched imaging URLs may contain client filenames or patient data.
  if (/^\/gateway\/imaging(?:\/|$)/iu.test(path)) return "/gateway/imaging/:operation";
  if (!/^\/gateway\/vision\/assets(?:\/|$)/iu.test(path)) return null;
  if (path.toLowerCase() === assetPath) return assetPath;
  const operation = /^\/gateway\/vision\/assets\/[^/]+\/(read-url|complete)\/?$/iu.exec(path)?.[1]?.toLowerCase();
  return `${assetPath}/:assetId${operation ? `/${operation}` : ""}`;
}

// Installed at the root so authentication failures and 404 contexts inherit it.
// Unrelated routes retain Fastify's original serializers and logger options.
export const gatewayChildLoggerFactory: NonNullable<FastifyServerOptions["childLoggerFactory"]> = (logger, bindings, options, rawRequest) => {
  const url = assetLogUrl(rawRequest.url);
  if (url === null) return logger.child(bindings, options);
  return logger.child(bindings, {
    ...options,
    serializers: {
      ...options.serializers,
      req: (request: FastifyRequest) => ({
        method: request.method,
        url,
        version: request.headers?.["accept-version"],
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort
      })
    }
  });
};
