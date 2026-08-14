export function validateFccArtifactManifest(manifest: unknown, expectedHash?: string): string[];
export function validateVenueVerificationManifest(manifest: unknown, expectedChainId?: number): string[];
export function validateProductionServiceConfig(environment: Readonly<Record<string, string | undefined>>): string[];
export function validateProductionApiConfig(environment: Readonly<Record<string, string | undefined>>): string[];
export function validateProductionIndexerConfig(environment: Readonly<Record<string, string | undefined>>): string[];
export function validateProductionKeeperConfig(environment: Readonly<Record<string, string | undefined>>): string[];
export function validateGovernanceManifest(manifest: unknown): string[];
