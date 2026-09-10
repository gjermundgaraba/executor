import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { OAuthProbeOutput, oauthProbeToolResult } from "./core-tools";

describe("agent OAuth probe output", () => {
  it.effect("preserves resource and protocol scopes through the tool's output schema", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(OAuthProbeOutput)(
        oauthProbeToolResult({
          authorizationUrl: "https://issuer.example/authorize",
          tokenUrl: "https://issuer.example/token",
          resource: "https://resource.example/mcp",
          scopesSupported: ["read", "write"],
          additionalAuthorizationScopes: ["offline_access"],
        }),
      );

      expect(result.scopesSupported).toEqual(["read", "write"]);
      expect(result.additionalAuthorizationScopes).toEqual(["offline_access"]);
    }),
  );

  it.effect("accepts probes without optional protocol scopes", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(OAuthProbeOutput)(
        oauthProbeToolResult({
          authorizationUrl: "https://issuer.example/authorize",
          tokenUrl: "https://issuer.example/token",
        }),
      );

      expect(result.additionalAuthorizationScopes).toBeUndefined();
      expect(result.issuer).toBeNull();
      expect(result.resource).toBeNull();
      expect(result.registrationEndpoint).toBeNull();
    }),
  );
});
