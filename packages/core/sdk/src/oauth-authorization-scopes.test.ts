import { describe, expect, it } from "@effect/vitest";

import {
  automaticAuthorizationScopes,
  oauthMetadataMatchesClient,
} from "./oauth-authorization-scopes";

const metadata = {
  issuer: "https://issuer.example",
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  scopes_supported: ["read", "write", "openid", "profile", "email", "offline_access"],
};

describe("automatic authorization scopes", () => {
  it("adds only issuer-advertised offline access independently of resource permissions", () => {
    expect(automaticAuthorizationScopes({ resourceDiscovered: true, metadata })).toEqual([
      "offline_access",
    ]);
  });

  it("does not infer protocol scopes without protected-resource metadata", () => {
    expect(automaticAuthorizationScopes({ resourceDiscovered: false, metadata })).toEqual([]);
  });

  it("does not add scopes when optional issuer discovery is unavailable", () => {
    expect(automaticAuthorizationScopes({ resourceDiscovered: true, metadata: null })).toEqual([]);
  });

  it.each(
    [undefined, [], ["read", "write", "openid"]].map((scopes_supported) => ({ scopes_supported })),
  )("does not request unsupported offline access (%j)", ({ scopes_supported }) => {
    expect(
      automaticAuthorizationScopes({
        resourceDiscovered: true,
        metadata: { ...metadata, scopes_supported },
      }),
    ).toEqual([]);
  });

  it("deduplicates repeated issuer advertisement", () => {
    expect(
      automaticAuthorizationScopes({
        resourceDiscovered: true,
        metadata: { ...metadata, scopes_supported: ["offline_access", "offline_access"] },
      }),
    ).toEqual(["offline_access"]);
  });
});

describe("issuer metadata selection", () => {
  const client = {
    authorizationUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
  };

  it("accepts metadata matching both selected endpoints", () => {
    expect(oauthMetadataMatchesClient(client, metadata)).toBe(true);
  });

  it("rejects a different authorization endpoint", () => {
    expect(
      oauthMetadataMatchesClient(client, {
        ...metadata,
        authorization_endpoint: "https://other.example/authorize",
      }),
    ).toBe(false);
  });

  it("rejects a different token endpoint", () => {
    expect(
      oauthMetadataMatchesClient(client, {
        ...metadata,
        token_endpoint: "https://other.example/token",
      }),
    ).toBe(false);
  });
});
