import type { CloudBaseFamilySettings } from "./cloudbase-family-sync.ts";

type CloudBaseRuntimeWindow = Window & {
  __SUMMER_PET_CLOUDBASE__?: Partial<CloudBaseFamilySettings>;
};

export function readCloudBaseBuildConfig(): CloudBaseFamilySettings | null {
  const runtime = typeof window === "undefined"
    ? undefined
    : (window as CloudBaseRuntimeWindow).__SUMMER_PET_CLOUDBASE__;
  const env = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env ?? {};
  const settings: CloudBaseFamilySettings = {
    envId: runtime?.envId ?? env.VITE_CLOUDBASE_ENV_ID ?? "",
    region:
      runtime?.region?.trim() ||
      env.VITE_CLOUDBASE_REGION?.trim() ||
      "ap-shanghai",
    publishableKey:
      runtime?.publishableKey ?? env.VITE_CLOUDBASE_PUBLISHABLE_KEY ?? "",
    functionName:
      runtime?.functionName ??
      env.VITE_CLOUDBASE_FUNCTION_NAME ??
      "summer-pet-family",
  };
  return settings.envId.trim() && settings.publishableKey.trim()
    ? settings
    : null;
}
