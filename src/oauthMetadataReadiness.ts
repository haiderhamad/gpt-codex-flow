/**
 * Offline OAuth metadata preflight for a proposed MCP Resource Server.
 *
 * This is deliberately not a token verifier, HTTP middleware, or evidence of
 * client identity. It must never turn on OAuth mode by itself.
 */
export type MetadataMap = Readonly<Record<string, unknown>>;

export interface OAuthMetadataPreflightInput {
  /** Canonical HTTPS MCP resource URI (possibly ending in /mcp). */
  expectedResource: string;
  /** Pre-registered OAuth client with verified credentials is an alternative to CIMD/DCR. */
  hasPreRegisteredClient?: boolean;
  protectedResource: MetadataMap;
  authorizationServer: MetadataMap;
}

export interface OAuthMetadataPreflightResult {
  metadataCompatible: boolean;
  errors: string[];
  warnings: string[];
  clientIdentityVerified: false;
  tokensValidated: false;
  runtimeEnforced: false;
}

function hasString(array: unknown, expected: string): boolean {
  return Array.isArray(array) && array.includes(expected);
}

function httpsUri(value: unknown, allowPath = true): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !!url.hostname &&
      !url.username && !url.password &&
      !url.hash && !url.search &&
      (allowPath || url.pathname === "/") &&
      !value.includes("?") && !value.includes("#") &&
      (value === url.toString() || (url.pathname === "/" && value === url.origin));
  } catch {
    return false;
  }
}

export function checkOAuthMetadata(input: OAuthMetadataPreflightInput): OAuthMetadataPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pr = input.protectedResource;
  const as = input.authorizationServer;

  if (!httpsUri(input.expectedResource)) {
    errors.push("expectedResource must be a canonical HTTPS URI without query or fragment");
  }
  if (pr.resource !== input.expectedResource) {
    errors.push("Protected resource identifier must exactly match the configured MCP resource");
  }
  if (!Array.isArray(pr.authorization_servers) ||
      !pr.authorization_servers.some(server => server === as.issuer)) {
    errors.push("Protected resource authorization_servers must include the exact selected issuer");
  }
  if (!httpsUri(as.issuer)) {
    errors.push("Authorization server issuer must be a canonical HTTPS URI");
  }
  for (const key of ["authorization_endpoint", "token_endpoint"] as const) {
    if (!httpsUri(as[key])) errors.push(`${key} must be an HTTPS URI`);
  }
  if (!hasString(as.code_challenge_methods_supported, "S256")) {
    errors.push("Authorization server must advertise S256 PKCE");
  }
  if (!hasString(as.response_types_supported, "code")) {
    errors.push("Authorization server must support authorization-code response type");
  }
  const jwtMethods = ["private_key_jwt", "client_secret_jwt"];
  if (jwtMethods.some(method => hasString(as.token_endpoint_auth_methods_supported, method))) {
    const algorithms = as.token_endpoint_auth_signing_alg_values_supported;
    if (!Array.isArray(algorithms) || algorithms.length === 0 ||
        algorithms.some(alg => typeof alg !== "string" || alg === "none")) {
      errors.push("JWT client authentication requires advertised non-none signing algorithms");
    }
  }
  const supportsCimd = as.client_id_metadata_document_supported === true;
  const supportsDcr = httpsUri(as.registration_endpoint);
  if (!supportsCimd && !supportsDcr && input.hasPreRegisteredClient !== true) {
    errors.push("Client registration needs CIMD, DCR or a pre-registered client");
  }
  if (supportsCimd && !(
    hasString(as.token_endpoint_auth_methods_supported, "none") ||
    hasString(as.token_endpoint_auth_methods_supported, "private_key_jwt")
  )) {
    errors.push("CIMD requires a token endpoint authentication method supported by ChatGPT");
  }
  if (as.authorization_response_iss_parameter_supported !== true) {
    warnings.push("Stable RFC 9207 callback cannot be assumed; use the connector's displayed callback URI");
  }
  if (supportsCimd &&
      !hasString(as.token_endpoint_auth_methods_supported, "private_key_jwt")) {
    warnings.push("CIMD without private_key_jwt does not authenticate the client at token exchange");
  }
  warnings.push(
    "Metadata alone never proves OAuth linking, signed token validation, caller identity, or session binding"
  );
  return {
    metadataCompatible: errors.length === 0,
    errors,
    warnings,
    clientIdentityVerified: false,
    tokensValidated: false,
    runtimeEnforced: false
  };
}
