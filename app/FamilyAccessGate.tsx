"use client";

import { FormEvent, ReactNode, useState } from "react";
import "./family-access.css";

export type FamilyDeviceRole = "child" | "parent";
export type FamilyAccessRoute = "child" | "parent";
export type FamilyAccessStatus =
  | "loading"
  | "unconfigured"
  | "pending"
  | "approved"
  | "denied"
  | "error";
export type FamilyAccessPhase = FamilyAccessStatus;

export interface FamilyDeviceRequest {
  requestId: string;
  deviceId: string;
  deviceName: string;
  requestedRole: FamilyDeviceRole;
  publicKey: string;
  createdAt: string;
  requestJson: string;
}

export interface FamilyAccessDevice {
  deviceId: string;
  deviceName: string;
  role?: FamilyDeviceRole;
  publicKey?: string;
}

export interface CreateFamilyDeviceRequestInput {
  deviceName: string;
  requestedRole: FamilyDeviceRole;
  familyPassphrase: string;
}

export interface FamilyAccessContentContext {
  surface: FamilyAccessRoute;
  device: FamilyAccessDevice;
  readOnly: boolean;
  pendingEventCount: number;
  refresh: () => Promise<void> | void;
}

/**
 * Pure presentation contract. FamilyApp owns IndexedDB/remote state and passes
 * only a serializable view model plus callbacks into this component.
 */
export interface FamilyAccessGateProps {
  surface: FamilyAccessRoute;
  status: FamilyAccessStatus;
  device?: FamilyAccessDevice | null;
  request?: FamilyDeviceRequest | null;
  online?: boolean;
  pendingEventCount?: number;
  unsentEventCount?: number;
  awaitingConfirmationCount?: number;
  retryableEventCount?: number;
  supersededEventCount?: number;
  lastSyncedAt?: string | null;
  errorMessage?: string;
  initialDeviceName?: string;
  cloudBaseReady?: boolean;
  syncProvider?: "github" | "cloudbase";
  migrationAvailable?: boolean;
  onCreateDeviceRequest: (
    input: CreateFamilyDeviceRequestInput,
  ) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onSyncNow?: () => Promise<void> | void;
  onMigrateToCloudBase?: () => Promise<void> | void;
  renderApp?: (context: FamilyAccessContentContext) => ReactNode;
  approvedContent?: ReactNode;
  children?: ReactNode;
  appName?: string;
  busy?: boolean;
}

function roleLabel(role: FamilyDeviceRole) {
  return role === "parent" ? "家长端" : "孩子端";
}

function formatDateTime(value?: string | null) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function CopyField({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  const copy = async () => {
    try {
      await copyText(value);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="family-copy-field">
      <div className="family-copy-heading">
        <strong>{label}</strong>
        <button type="button" className="family-button is-quiet" onClick={copy}>
          {copyState === "copied"
            ? "已复制"
            : copyState === "error"
              ? "复制失败"
              : "复制"}
        </button>
      </div>
      {multiline ? (
        <pre tabIndex={0}>{value}</pre>
      ) : (
        <code tabIndex={0}>{value}</code>
      )}
    </div>
  );
}

function StatusNotice({
  online,
  pendingEventCount,
  unsentEventCount,
  awaitingConfirmationCount,
  retryableEventCount,
  supersededEventCount,
  syncing,
  errorMessage,
  onSync,
}: {
  online: boolean;
  pendingEventCount: number;
  unsentEventCount: number;
  awaitingConfirmationCount: number;
  retryableEventCount: number;
  supersededEventCount: number;
  syncing: boolean;
  errorMessage?: string;
  onSync?: () => Promise<void>;
}) {
  const offline = !online;
  const hasPendingEvents = pendingEventCount > 0;
  const hasError = Boolean(errorMessage);
  const queueDetails = [
    unsentEventCount > 0 ? `${unsentEventCount} 条尚未发送` : "",
    awaitingConfirmationCount > 0
      ? `${awaitingConfirmationCount} 条已发送待确认`
      : "",
    retryableEventCount > 0 ? `${retryableEventCount} 条等待重试` : "",
  ].filter(Boolean).join("，");
  if (!offline && !hasPendingEvents && !hasError) return null;

  return (
    <aside
      className={`family-status-notice${offline ? " is-offline" : ""}${hasError ? " is-error" : ""}`}
      aria-live="polite"
    >
      <span aria-hidden="true">{hasError ? "!" : offline ? "☁️" : "↻"}</span>
      <div>
        <strong>
          {hasError
            ? "同步遇到问题，本机记录仍然安全"
            : offline
              ? "当前离线，可继续在本机使用"
              : "有内容等待同步"}
        </strong>
        <p>
          {hasError
            ? errorMessage
            : offline
            ? `新操作会安全留在本机，联网后再同步${
                hasPendingEvents
                  ? `；${queueDetails}`
                  : ""
              }。`
            : `${queueDetails || `本机有 ${pendingEventCount} 条内容待同步`}。${
                supersededEventCount > 0
                  ? ` 已自动合并 ${supersededEventCount} 条连续旧快照。`
                  : ""
              }`}
        </p>
      </div>
      {!offline && onSync ? (
        <button
          type="button"
          className="family-button is-secondary"
          onClick={() => void onSync()}
          disabled={syncing}
        >
          {syncing ? "同步中…" : "立即同步"}
        </button>
      ) : null}
    </aside>
  );
}

export default function FamilyAccessGate({
  surface,
  status,
  device,
  request,
  online = true,
  pendingEventCount = 0,
  unsentEventCount = 0,
  awaitingConfirmationCount = 0,
  retryableEventCount = 0,
  supersededEventCount = 0,
  lastSyncedAt,
  errorMessage,
  initialDeviceName = "",
  cloudBaseReady = false,
  syncProvider = "cloudbase",
  migrationAvailable = false,
  onCreateDeviceRequest,
  onRefresh,
  onSyncNow,
  onMigrateToCloudBase,
  renderApp,
  approvedContent,
  children,
  appName = "家庭成长记录",
  busy: externalBusy = false,
}: FamilyAccessGateProps) {
  const [localBusy, setLocalBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [deviceName, setDeviceName] = useState(initialDeviceName);
  const [familyPassphrase, setFamilyPassphrase] = useState("");
  const busy = externalBusy || localBusy;

  const runAction = async (
    action: () => Promise<void> | void,
    fallbackMessage: string,
  ) => {
    setLocalBusy(true);
    setOperationError("");
    try {
      await action();
    } catch (error) {
      setOperationError(
        error instanceof Error ? error.message : fallbackMessage,
      );
    } finally {
      setLocalBusy(false);
    }
  };

  const refresh = () => runAction(onRefresh, "刷新失败，请稍后再试。");
  const syncNow = onSyncNow
    ? () => runAction(onSyncNow, "同步失败，请稍后再试。")
    : undefined;

  const createRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction(
      async () => {
        await onCreateDeviceRequest({
          deviceName: deviceName.trim() || "我的设备",
          requestedRole: surface,
          familyPassphrase,
        });
        setFamilyPassphrase("");
      },
      "设备申请创建失败。",
    );
  };

  const accessMismatch =
    status === "denied" ||
    (status === "approved" && (!device?.role || device.role !== surface));
  const context: FamilyAccessContentContext | null = device
    ? {
        surface,
        device,
        readOnly: false,
        pendingEventCount,
        refresh,
      }
    : null;
  const content =
    renderApp && context ? renderApp(context) : approvedContent ?? children;

  return (
    <main className={`family-access-shell family-surface-${surface}`}>
      <header className="family-access-header">
        <div className="family-access-brand" aria-hidden="true">
          🏠
        </div>
        <div>
          <p className="family-eyebrow">
            {surface === "parent" ? "家长管理入口" : "孩子日常入口"}
          </p>
          <h1>{appName}</h1>
        </div>
      </header>

      {status === "loading" ? (
        <section
          className="family-access-card family-centered"
          aria-live="polite"
        >
          <div className="family-spinner" aria-hidden="true" />
          <h2>正在读取本机配置</h2>
          <p>请稍候，不会上传或显示你的密钥。</p>
        </section>
      ) : status === "unconfigured" ? (
        <section className="family-access-card family-setup-card">
          <div className="family-section-heading">
            <span className="family-state-icon" aria-hidden="true">
              ✨
            </span>
            <div>
              <p className="family-eyebrow">首次配置</p>
              <h2>申请成为{roleLabel(surface)}</h2>
              <p>
                这台设备会在本机生成独立密钥，并把设备申请自动发送到家长端。
              </p>
              <p>
                如果要从旧网址迁移，请先在旧站家长设置里导出 JSON 备份；新家长端配置完成后再导入，浏览器不会自动跨网址搬运 IndexedDB。
              </p>
            </div>
          </div>

          <form className="family-form" onSubmit={createRequest}>
            {!cloudBaseReady ? (
              <p className="family-inline-warning" role="status">
                CloudBase 尚未接入发布版。请先完成环境配置，再刷新本页。
                <a
                  href="https://tcb.cloud.tencent.com/dev"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开 CloudBase 控制台
                </a>
              </p>
            ) : null}
            <label>
              <span>设备名称</span>
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="例如：客厅 iPad"
                autoComplete="off"
                maxLength={60}
              />
            </label>
            <label>
              <span>家庭口令</span>
              <input
                type="password"
                value={familyPassphrase}
                onChange={(event) => setFamilyPassphrase(event.target.value)}
                placeholder="用于解锁家庭数据"
                autoComplete="off"
                required
              />
              <small>
                口令只在本次配置时传给适配器，不持久保存明文。
              </small>
            </label>

            {operationError ? (
              <p className="family-inline-error" role="alert">
                {operationError}
              </p>
            ) : null}
            <button
              type="submit"
              className="family-button is-primary is-wide"
              disabled={busy || !cloudBaseReady}
            >
              {busy ? "正在连接家庭空间…" : "连接家庭空间"}
            </button>
          </form>
        </section>
      ) : status === "pending" ? (
        <section className="family-access-card">
          <div className="family-section-heading">
            <span className="family-state-icon is-waiting" aria-hidden="true">
              ⏳
            </span>
            <div>
              <p className="family-eyebrow">等待批准</p>
              <h2>请让家长批准这台设备</h2>
              <p>
                申请已经自动发送。让家长在“设置 → 设备”中点击批准，然后回到这里刷新状态。
              </p>
            </div>
          </div>

          {request ? (
            <div className="family-copy-grid">
              <CopyField label="Device ID" value={request.deviceId} />
              {syncProvider === "github" ? (
                <CopyField
                  label="GitHub 旧同步的设备申请 JSON"
                  value={request.requestJson}
                  multiline
                />
              ) : null}
            </div>
          ) : (
            <p className="family-inline-error" role="alert">
              本机申请信息不完整，请重新读取后再试。
            </p>
          )}

          {operationError ? (
            <p className="family-inline-error" role="alert">
              {operationError}
            </p>
          ) : null}
          <button
            type="button"
            className="family-button is-primary is-wide"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? "正在检查…" : "我已让家长批准，刷新状态"}
          </button>
        </section>
      ) : status === "error" ? (
        <section className="family-access-card family-centered is-error">
          <span className="family-state-icon" aria-hidden="true">
            !
          </span>
          <p className="family-eyebrow">设备状态异常</p>
          <h2>无法验证家庭访问权限</h2>
          <p>
            {errorMessage || operationError || "请检查网络和本机配置后重试。"}
          </p>
          <button
            type="button"
            className="family-button is-primary"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? "正在重试…" : "重试"}
          </button>
        </section>
      ) : accessMismatch ? (
        <section className="family-access-card family-centered is-denied">
          <span className="family-state-icon" aria-hidden="true">
            🔒
          </span>
          <p className="family-eyebrow">无权限</p>
          <h2>这台设备不能打开{roleLabel(surface)}</h2>
          <p>
            当前设备角色是
            {device?.role ? roleLabel(device.role) : "未识别角色"}
            。孩子设备不会显示或进入家长管理功能。
          </p>
          <a
            className="family-button is-primary"
            href={device?.role === "parent" ? "#/parent" : "#/child"}
          >
            返回{device?.role === "parent" ? "家长" : "孩子"}入口
          </a>
        </section>
      ) : status === "approved" ? (
        <>
          {migrationAvailable && onMigrateToCloudBase ? (
            <aside className="family-status-notice" aria-live="polite">
              <span aria-hidden="true">☁️</span>
              <div>
                <strong>可以升级到 CloudBase 实时同步</strong>
                <p>
                  本机 IndexedDB 和历史记录不会被清除。根家长设备请最先迁移，其他设备随后迁移。
                </p>
              </div>
              <button
                type="button"
                className="family-button is-secondary"
                onClick={() => void runAction(
                  onMigrateToCloudBase,
                  "迁移到 CloudBase 失败，请保留 GitHub 旧同步并稍后重试。",
                )}
                disabled={busy}
              >
                {busy ? "迁移中…" : "迁移到 CloudBase"}
              </button>
            </aside>
          ) : null}
          <StatusNotice
            online={online}
            pendingEventCount={pendingEventCount}
            unsentEventCount={unsentEventCount}
            awaitingConfirmationCount={awaitingConfirmationCount}
            retryableEventCount={retryableEventCount}
            supersededEventCount={supersededEventCount}
            syncing={busy}
            errorMessage={errorMessage || operationError}
            onSync={syncNow}
          />
          <section
            className="family-approved-content"
            aria-label={online ? "家庭应用内容" : "家庭应用内容，离线操作稍后同步"}
          >
            {content}
          </section>
          <footer className="family-sync-footer">
            <div>
              <span>
                {online ? "已批准设备" : "离线本机模式"} · 上次同步：
                {formatDateTime(lastSyncedAt)}
              </span>
              {online && syncNow ? (
                <button
                  type="button"
                  className="family-footer-sync"
                  onClick={() => void syncNow()}
                  disabled={busy}
                >
                  {busy ? "同步中…" : "立即同步"}
                </button>
              ) : null}
            </div>
            <code>{device?.deviceId}</code>
          </footer>
        </>
      ) : (
        <section className="family-access-card family-centered is-error">
          <h2>未识别的设备状态</h2>
          <button
            type="button"
            className="family-button is-primary"
            onClick={() => void refresh()}
          >
            重新读取
          </button>
        </section>
      )}

      <p className="family-disclaimer">
        仅供家庭非商用使用 · 非官方产品 · 请勿在共享设备上保存个人访问凭据
      </p>
    </main>
  );
}
