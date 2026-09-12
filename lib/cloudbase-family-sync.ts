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

type CloudBaseFailure = {
  message?: string;
  code?: string;
  requestId?: string;
};

type CloudBaseSessionResult = {
  data: { session?: unknown } | null;
  error: CloudBaseFailure | null;
};

type CloudBaseApp = {
  auth: {
    getSession(): Promise<CloudBaseSessionResult>;
    signInAnonymously(): Promise<CloudBaseSessionResult>;
  };
  callFunction(options: {
    name: string;
    data: Record<string, unknown>;
    parse?: boolean;
  }): Promise<CloudBaseFailure & { result?: unknown }>;
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

async function loadCloudBaseSdk(): Promise<CloudBaseSdk> {
  const imported = await import("@cloudbase/js-sdk");
  return (imported.default ?? imported) as unknown as CloudBaseSdk;
}

function cloudBaseError(failure: CloudBaseFailure, fallback: string) {
  const details = [
    failure.code,
    failure.requestId ? `请求 ID：${failure.requestId}` : "",
  ].filter(Boolean);
  const message = failure.message || fallback;
  return Object.assign(
    new Error(details.length ? `${message}（${details.join("；")}）` : message),
    { code: failure.code, requestId: failure.requestId },
  );
}

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
  private readonly sdkLoader: () => Promise<CloudBaseSdk>;

  constructor(
    settings: CloudBaseFamilySettings,
    options: {
      deviceRequestKey?: CryptoKey | null;
      sdkLoader?: () => Promise<CloudBaseSdk>;
    } = {},
  ) {
    this.settings = normalizeCloudBaseSettings(settings);
    this.deviceRequestKey = options.deviceRequestKey ?? null;
    this.sdkLoader = options.sdkLoader ?? loadCloudBaseSdk;
  }

  private async app() {
    if (!this.appPromise) {
      this.appPromise = (async () => {
        const sdk = await this.sdkLoader();
        const app = sdk.init({
          env: this.settings.envId,
          region: this.settings.region,
          accessKey: this.settings.publishableKey,
          timeout: 20_000,
        });
        const auth = app.auth;
        const session = await auth.getSession();
        if (session.error) {
          throw cloudBaseError(session.error, "CloudBase 登录状态检查失败");
        }
        // A Publishable Key is not a user session, even if legacy login state exists.
        if (!session.data?.session) {
          const signedIn = await auth.signInAnonymously();
          if (signedIn.error) {
            throw cloudBaseError(
              signedIn.error,
              "CloudBase 匿名登录失败，请检查登录方式配置",
            );
          }
          if (!signedIn.data?.session) {
            throw new Error("CloudBase 匿名登录未建立有效会话，请检查登录方式配置");
          }
        }
        return app;
      })();
    }
    const pending = this.appPromise;
    try {
      return await pending;
    } catch (error) {
      // A later explicit attempt may recover; concurrent failures cannot clear a newer attempt.
      if (this.appPromise === pending) this.appPromise = null;
      throw error;
    }
  }

  private async call<T>(action: string, data: Record<string, unknown> = {}) {
    const app = await this.app();
    const response = await app.callFunction({
      name: this.settings.functionName,
      data: { action, ...data },
      parse: true,
    });
    // The SDK can resolve platform errors instead of rejecting the request.
    if (response?.code) {
      throw cloudBaseError(response, "CloudBase 云函数调用失败");
    }
    return parseCallResult<T>(response?.result);
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
