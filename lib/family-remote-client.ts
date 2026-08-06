import type {
  DeviceRequest,
  FamilyConfig,
  FamilyEventEnvelope,
  GitHubEventBatch,
} from "./github-family-sync.ts";

export type FamilyRemoteConfigResult = {
  config: FamilyConfig;
  revision: string;
};

/**
 * Storage-neutral transport used by the encrypted family sync engine.
 * Implementations may use GitHub or CloudBase, but never receive plaintext
 * household data.
 */
export interface FamilyRemoteClient {
  readConfig(): Promise<FamilyRemoteConfigResult>;
  listEventsWithIndex<T = unknown>(
    excludeIds?: ReadonlySet<string>,
  ): Promise<GitHubEventBatch<T>>;
  dispatchEvent(event: FamilyEventEnvelope): Promise<void>;
  initializeConfig(config: FamilyConfig): Promise<FamilyRemoteConfigResult>;
  updateConfig(
    config: FamilyConfig,
    expectedRevision: string,
  ): Promise<FamilyRemoteConfigResult>;
  submitDeviceRequest?(request: DeviceRequest): Promise<void>;
  listDeviceRequests?(): Promise<DeviceRequest[]>;
  resolveDeviceRequest?(deviceId: string): Promise<void>;
}
