import {
  checkOAuthMetadata,
  type OAuthMetadataPreflightInput
} from "./oauthMetadataReadiness.js";

/**
 * Prepares discovery responses for a disposable OAuth compatibility fixture.
 * This does NOT register production routes or verify any caller credentials.
 */
export interface OAuthDiscoveryContractInput extends OAuthMetadataPreflightInput {
  /** A single narrow test scope, never model-supplied at request time. */
  initialScope: string;
}

export interface OAuthDiscoveryContract {
  protectedResourcePath: string;
  protectedResourceUrl: string;
  protectedResourceMetadata: Readonly<Record<string, unknown>>;
  challenge: string;
  /** Only a wire-format fixture: no token is ever accepted. */
  authenticated: false;
}

export function createOAuthDiscoveryContract(
  input: OAuthDiscoveryContractInput
): OAuthDiscoveryContract {
  const readiness = checkOAuthMetadata(input);
  if (!readiness.metadataCompatible) {
    throw new Error("OAuth discovery preflight failed: " + readiness.errors.join("; "));
  }
  const scope = input.initialScope;
  // Keep header rendering strict, despite the wider RFC 6749 scope-token grammar.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(scope)) {
    throw new Error("Initial OAuth scope must be a single simple scope identifier.");
  }

  const availableScopes = input.protectedResource.scopes_supported;
  if (!Array.isArray(availableScopes) || !availableScopes.includes(scope)) {
    throw new Error("Initial OAuth scope must be advertised by the protected resource.");
  }

  const resource = new URL(input.expectedResource);
  const resourcePath = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  // RFC 9728 supports the root URI and path-specific metadata URI.
  const protectedResourcePath = "/.well-known/oauth-protected-resource" + resourcePath;
  const protectedResourceUrl = resource.origin + protectedResourcePath;
  const protectedResourceMetadata = Object.freeze({
    ...input.protectedResource,
    resource: input.expectedResource
  });
  const challenge = `Bearer resource_metadata="${protectedResourceUrl}", scope="${scope}"`;

  return Object.freeze({
    protectedResourcePath,
    protectedResourceUrl,
    protectedResourceMetadata,
    challenge,
    authenticated: false as const
  });
}
