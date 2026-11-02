/** Extension point for a future OIDC/Keycloak guard. Queue messages are a trusted internal channel. */
export interface ProviderIdentityPort { providerId(): Promise<string | null>; }
export class NoopProviderIdentityPort implements ProviderIdentityPort { async providerId(): Promise<string | null> { return null; } }
