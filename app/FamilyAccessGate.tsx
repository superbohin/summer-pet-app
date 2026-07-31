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
  githubOwner: string;
  githubRepository: string;
  githubBranch: string;
  workflowRef: string;
  githubToken: string;
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
 * Pure presentation contract. FamilyApp owns IndexedDB/GitHub state and passes
 * only a serializable view model plus callbacks into this component.
 */
export interface FamilyAccessGateProps {
  surface: FamilyAccessRoute;
  status: FamilyAccessStatus;
  device?: FamilyAccessDevice | null;
  request?: FamilyDeviceRequest | null;
  online?: boolean;
  pendingEventCount?: number;
  lastSyncedAt?: string | null;
  errorMessage?: string;
  initialDeviceName?: string;
  initialGitHubOwner?: string;
  initialGitHubRepository?: string;
  initialGitHubBranch?: string;
  initialWorkflowRef?: string;
  onCreateDeviceRequest: (
    input: CreateFamilyDeviceRequestInput,
  ) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onSyncNow?: () => Promise<void> | void;
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
  syncing,
  errorMessage,
  onSync,
}: {
  online: boolean;
  pendingEventCount: number;
  syncing: boolean;
  errorMessage?: string;
  onSync?: () => Promise<void>;
}) {
  const offline = !online;
  const hasPendingEvents = pendingEventCount > 0;
  const hasError = Boolean(errorMessage);
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
                  ? `；本机还有 ${pendingEventCount} 条事件待同步`
                  : ""
              }。`
            : `本机有 ${pendingEventCount} 条事件尚未同步。`}
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
  lastSyncedAt,
  errorMessage,
  initialDeviceName = "",
  initialGitHubOwner = "",
  initialGitHubRepository = "",
  initialGitHubBranch = "main",
  initialWorkflowRef = "family-sync.yml",
  onCreateDeviceRequest,
  onRefresh,
  onSyncNow,
  renderApp,
  approvedContent,
  children,
  appName = "家庭成长记录",
  busy: externalBusy = false,
}: FamilyAccessGateProps) {
  const [localBusy, setLocalBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [deviceName, setDeviceName] = useState(initialDeviceName);
  const [githubOwner, setGitHubOwner] = useState(initialGitHubOwner);
  const [githubRepository, setGitHubRepository] = useState(
    initialGitHubRepository,
  );
  const [githubBranch, setGitHubBranch] = useState(initialGitHubBranch);
  const [workflowRef, setWorkflowRef] = useState(initialWorkflowRef);
  const [githubToken, setGithubToken] = useState("");
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
          githubOwner: githubOwner.trim(),
          githubRepository: githubRepository.trim(),
          githubBranch: githubBranch.trim() || "main",
          workflowRef: workflowRef.trim() || "family-sync.yml",
          githubToken,
          familyPassphrase,
        });
        setGithubToken("");
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
    <main className="family-access-shell">
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
                这台设备会在本机生成独立密钥，并创建一份可交给家长批准的设备申请。
              </p>
              <p>
                如果要从旧网址迁移，请先在旧站家长设置里导出 JSON 备份；新家长端配置完成后再导入，浏览器不会自动跨网址搬运 IndexedDB。
              </p>
            </div>
          </div>

          <form className="family-form" onSubmit={createRequest}>
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
            <div className="family-form-row">
              <label>
                <span>GitHub 用户或组织</span>
                <input
                  value={githubOwner}
                  onChange={(event) => setGitHubOwner(event.target.value)}
                  placeholder="例如：xia-family"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>
              <label>
                <span>家庭数据仓库</span>
                <input
                  value={githubRepository}
                  onChange={(event) => setGitHubRepository(event.target.value)}
                  placeholder="例如：summer-pet-data"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>
            </div>
            <div className="family-form-row">
              <label>
                <span>分支</span>
                <input
                  value={githubBranch}
                  onChange={(event) => setGitHubBranch(event.target.value)}
                  placeholder="main"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>同步 Workflow</span>
                <input
                  value={workflowRef}
                  onChange={(event) => setWorkflowRef(event.target.value)}
                  placeholder="family-sync.yml"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            </div>
            <label>
              <span>GitHub Token</span>
              <input
                type="password"
                value={githubToken}
                onChange={(event) => setGithubToken(event.target.value)}
                placeholder="输入后不会回显"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <small>
                仅交给本机适配器保存到 IndexedDB，不会写入页面、网址或申请 JSON。
              </small>
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
              disabled={busy}
            >
              {busy ? "正在创建设备申请…" : "生成设备申请"}
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
                将下面的申请 JSON 交给已批准的家长端。批准后，回到这里刷新状态。
              </p>
            </div>
          </div>

          {request ? (
            <div className="family-copy-grid">
              <CopyField label="Device ID" value={request.deviceId} />
              <CopyField label="设备公钥" value={request.publicKey} />
              <CopyField
                label="完整设备申请 JSON"
                value={request.requestJson}
                multiline
              />
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
          <StatusNotice
            online={online}
            pendingEventCount={pendingEventCount}
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
            <span>
              {online ? "已批准设备" : "离线本机模式"} · 上次同步：
              {formatDateTime(lastSyncedAt)}
            </span>
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
