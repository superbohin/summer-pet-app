import { createCloudBaseFamilyClient } from "./cloudbase-family-sync.ts";
import type { FamilyConnectionProfile } from "./family-device-store.ts";
import type { FamilyRemoteClient } from "./family-remote-client.ts";
import { createGithubFamilyClient } from "./github-family-sync.ts";

export function familySyncProvider(profile: FamilyConnectionProfile) {
  return profile.provider ?? "github";
}

export function createFamilyRemoteClient(
  profile: FamilyConnectionProfile,
): FamilyRemoteClient {
  if (familySyncProvider(profile) === "cloudbase") {
    if (!profile.cloudbase) throw new Error("本机缺少 CloudBase 连接配置");
    return createCloudBaseFamilyClient(profile.cloudbase, {
      deviceRequestKey: profile.deviceRequestKey,
    });
  }
  const client = createGithubFamilyClient({
    owner: profile.owner,
    repo: profile.repo,
    branch: profile.branch,
    workflowRef: profile.workflowRef,
  });
  return {
    async readConfig() {
      const result = await client.readConfig(profile.token);
      return { config: result.config, revision: result.sha };
    },
    listEventsWithIndex<T = unknown>(excludeIds: ReadonlySet<string> = new Set()) {
      return client.listEventsWithIndex<T>(profile.token, excludeIds);
    },
    dispatchEvent(event) {
      return client.dispatchEvent(profile.token, event);
    },
    async initializeConfig(config) {
      const result = await client.initializeConfig(profile.token, config);
      return { config: result.config, revision: result.sha };
    },
    async updateConfig(config, expectedRevision) {
      const result = await client.updateConfig(
        profile.token,
        config,
        expectedRevision,
      );
      return { config: result.config, revision: result.sha };
    },
  };
}
