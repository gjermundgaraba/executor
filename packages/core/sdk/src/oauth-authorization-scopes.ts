import type { OAuthAuthorizationServerMetadata } from "./oauth-discovery";

export const canonicalUrlString = (value: string): string => {
  const url = new URL(value.trim());
  url.hash = "";
  return url.toString();
};

/** Discovery from another app's issuer must never change the selected app's scopes. */
export const oauthMetadataMatchesClient = (
  client: { readonly authorizationUrl: string; readonly tokenUrl: string },
  metadata: OAuthAuthorizationServerMetadata,
): boolean =>
  canonicalUrlString(metadata.authorization_endpoint) ===
    canonicalUrlString(client.authorizationUrl) &&
  canonicalUrlString(metadata.token_endpoint) === canonicalUrlString(client.tokenUrl);

/** Resource permissions and issuer protocol scopes have separate authorities.
 *  Only offline access is added automatically; identity scopes remain opt-in. */
export const automaticAuthorizationScopes = (input: {
  readonly resourceDiscovered: boolean;
  readonly metadata: OAuthAuthorizationServerMetadata | null;
}): readonly string[] =>
  input.resourceDiscovered && input.metadata?.scopes_supported?.includes("offline_access") === true
    ? ["offline_access"]
    : [];
