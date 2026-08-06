import type {
  DeviceRequest,
  FamilyConfig,
  FamilyEventEnvelope,
  GitHubEventBatch,
} from "./github-family-sync.ts";
import { createHouseholdRequestProof } from "./github-family-sync.ts";
import type {
  FamilyRemoteClient,
  FamilyRemoteConfigResult,
} from "./family-remote-client.ts";

export type CloudBaseFamilySettings = {
  envId: string;
  region: string;
  publishableKey: string;
  functionName: string;
};

type CloudBaseCallResult<T> = {
  ok: true;
  data: T;
};

type CloudBaseApp = {
  auth(): {
    getLoginState(): Promise<unknown>;
    signInAnonymously(): Promise<{
      data: unknown;
      error: { message?: string } | null;
    }>;
  };
  callFunction<T>(options: {
    name: string;
    data: Record<string, unknown>;
    parse?: boolean;
  }): Promise<{ result: T }>;
};

type CloudBaseSdk = {
  init(options: {
    env: string;
    region: string;
    accessKey: string;
    timeout?: number;
  }): CloudBaseApp;
};

const DEFAULT_FUNCTION_NAME = "summer-pet-family";

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`CloudBase ${label} 尚未配置`);
  return normalized;
}

export function normalizeCloudBaseSettings(
  settings: CloudBaseFamilySettings,
): CloudBaseFamilySettings {
  return {
    envId: required(settings.envId, "EnvId"),
    region: required(settings.region, "地域"),
    publishableKey: required(settings.publishableKey, "Publishable Key"),
    functionName: settings.functionName.trim() || DEFAULT_FUNCTION_NAME,
  };
}

function parseCallResult<T>(value: unknown): T {
  let result = value;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result) as unknown;
    } catch {
      throw new Error("CloudBase 云函数返回了无法识别的内容");
    }
  }
  if (!result || typeof result !== "object") {
    throw new Error("CloudBase 云函数没有返回有效结果");
  }
  const response = result as Partial<CloudBaseCallResult<T>> & {
    error?: string;
  };
  if (response.ok !== true) {
    throw new Error(response.error || "CloudBase 云函数调用失败");
  }
  return response.data as T;
}

export class CloudBaseFamilyClient implements FamilyRemoteClient {
  readonly settings: CloudBaseFamilySettings;
  private appPromise: Promise<CloudBaseApp> | null = null;
  private readonly deviceRequestKey: CryptoKey | null;

  constructor(
    settings: CloudBaseFamilySettings,
    options: { deviceRequestKey?: CryptoKey | null } = {},
  ) {
    this.settings = normalizeCloudBaseSettings(settings);
    this.deviceRequestKey = options.deviceRequestKey ?? null;
  }

  private async app() {
    if (!this.appPromise) {
      this.appPromise = (async () => {
        const imported = await import("@cloudbase/js-sdk");
        const sdk = (imported.default ?? imported) as unknown as CloudBaseSdk;
        const app = sdk.init({
          env: this.settings.envId,
          region: this.settings.region,
          accessKey: this.settings.publishableKey,
          timeout: 20_000,
        });
        const auth = app.auth();
        const loginState = await auth.getLoginState();
        if (!loginState) {
          const signedIn = await auth.signInAnonymously();
          if (signedIn.error) {
            throw new Error(
              signedIn.error.message || "CloudBase 匿名登录失败，请检查登录方式配置",
            );
          }
        }
        return app;
      })();
    }
    return this.appPromise;
  }

  private async call<T>(action: string, data: Record<string, unknown> = {}) {
    const app = await this.app();
    const response = await app.callFunction<CloudBaseCallResult<T>>({
      name: this.settings.functionName,
      data: { action, ...data },
      parse: true,
    });
    return parseCallResult<T>(response.result);
  }

  async health() {
    return this.call<{ service: string; schemaVersion: number }>("health");
  }

  readConfig() {
    return this.call<FamilyRemoteConfigResult>("getConfig");
  }

  async listEventsWithIndex<T = unknown>(excludeIds: ReadonlySet<string> = new Set()) {
    return this.call<GitHubEventBatch<T>>("listEvents", {
      excludeIds: [...excludeIds],
      requestProof: await this.requestProof({ action: "listEvents" }),
    });
  }

  async dispatchEvent(event: FamilyEventEnvelope) {
    await this.call<{ accepted: true; eventId: string }>("appendEvent", {
      event,
    });
  }

  initializeConfig(config: FamilyConfig) {
    return this.call<FamilyRemoteConfigResult>("initializeConfig", { config });
  }

  initializeConfigWithRequestKey(
    config: FamilyConfig,
    requestProofKey: string,
  ) {
    return this.call<FamilyRemoteConfigResult>("initializeConfig", {
      config,
      requestProofKey,
    });
  }

  updateConfig(config: FamilyConfig, expectedRevision: string) {
    return this.call<FamilyRemoteConfigResult>("updateConfig", {
      config,
      expectedRevision,
    });
  }

  async submitDeviceRequest(request: DeviceRequest) {
    await this.call<{ accepted: true }>("submitDeviceRequest", {
      request,
      requestProof: await this.requestProof({
        action: "submitDeviceRequest",
        request,
      }),
    });
  }

  async listDeviceRequests() {
    const result = await this.call<{ requests: DeviceRequest[] }>(
      "listDeviceRequests",
      {
        requestProof: await this.requestProof({
          action: "listDeviceRequests",
        }),
      },
    );
    return result.requests;
  }

  async resolveDeviceRequest(deviceId: string) {
    await this.call<{ accepted: true }>("resolveDeviceRequest", {
      deviceId,
      requestProof: await this.requestProof({
        action: "resolveDeviceRequest",
        deviceId,
      }),
    });
  }

  private async requestProof(payload: unknown) {
    if (!this.deviceRequestKey) {
      throw new Error("本机缺少 CloudBase 设备申请授权密钥，请重新完成家庭配置");
    }
    return createHouseholdRequestProof(this.deviceRequestKey, payload);
  }
}

export function createCloudBaseFamilyClient(
  settings: CloudBaseFamilySettings,
  options: { deviceRequestKey?: CryptoKey | null } = {},
) {
  return new CloudBaseFamilyClient(settings, options);
}
