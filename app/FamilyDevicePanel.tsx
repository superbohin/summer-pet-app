"use client";

import { FormEvent, useMemo, useState } from "react";
import type {
  FamilyDeviceRequest,
  FamilyDeviceRole,
} from "./FamilyAccessGate";
import "./family-access.css";

export type FamilyDeviceStatus = "pending" | "approved" | "revoked";

export interface FamilyDeviceListItem {
  deviceId: string;
  deviceName: string;
  role: FamilyDeviceRole;
  status: FamilyDeviceStatus;
  publicKey?: string;
  createdAt?: string;
  approvedAt?: string;
  lastSyncedAt?: string | null;
}

export interface ApproveFamilyDeviceInput {
  requestId: string;
  deviceId: string;
  role: FamilyDeviceRole;
}

export interface FamilyDevicePanelProps {
  devices: FamilyDeviceListItem[];
  pendingRequests: FamilyDeviceRequest[];
  currentDeviceId?: string;
  online: boolean;
  busy?: boolean;
  automaticRequests?: boolean;
  onAddDeviceRequest: (requestJson: string) => Promise<void> | void;
  onApproveDevice: (input: ApproveFamilyDeviceInput) => Promise<void> | void;
  onRevokeDevice: (deviceId: string) => Promise<void> | void;
  onRefresh?: () => Promise<void> | void;
}

function roleLabel(role: FamilyDeviceRole) {
  return role === "parent" ? "家长" : "孩子";
}

function statusLabel(status: FamilyDeviceStatus) {
  if (status === "approved") return "已批准";
  if (status === "revoked") return "已撤销";
  return "待批准";
}

function formatDateTime(value?: string | null) {
  if (!value) return "从未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function FamilyDevicePanel({
  devices,
  pendingRequests,
  currentDeviceId,
  online,
  busy = false,
  automaticRequests = false,
  onAddDeviceRequest,
  onApproveDevice,
  onRevokeDevice,
  onRefresh,
}: FamilyDevicePanelProps) {
  const [requestJson, setRequestJson] = useState("");
  const [requestRoles, setRequestRoles] = useState<
    Record<string, FamilyDeviceRole>
  >({});
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [localBusyKey, setLocalBusyKey] = useState("");
  const [localError, setLocalError] = useState("");

  const sortedDevices = useMemo(
    () =>
      [...devices].sort((left, right) => {
        if (left.status !== right.status) {
          const order: Record<FamilyDeviceStatus, number> = {
            approved: 0,
            pending: 1,
            revoked: 2,
          };
          return order[left.status] - order[right.status];
        }
        return left.deviceName.localeCompare(right.deviceName, "zh-CN");
      }),
    [devices],
  );

  const runAction = async (key: string, action: () => Promise<void> | void) => {
    setLocalBusyKey(key);
    setLocalError("");
    try {
      await action();
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : "操作失败，请稍后再试。",
      );
    } finally {
      setLocalBusyKey("");
    }
  };

  const addRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = requestJson.trim();
    if (!trimmed) {
      setLocalError("请粘贴完整的设备申请 JSON。");
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("设备申请 JSON 格式不正确。");
      }
    } catch {
      setLocalError("设备申请 JSON 无法解析，请检查是否复制完整。");
      return;
    }
    await runAction("add-request", async () => {
      await onAddDeviceRequest(trimmed);
      setRequestJson("");
    });
  };

  const approve = async (request: FamilyDeviceRequest) => {
    const role = requestRoles[request.requestId] ?? request.requestedRole;
    await runAction(`approve-${request.requestId}`, () =>
      onApproveDevice({
        requestId: request.requestId,
        deviceId: request.deviceId,
        role,
      }),
    );
  };

  const revoke = async (deviceId: string) => {
    await runAction(`revoke-${deviceId}`, async () => {
      await onRevokeDevice(deviceId);
      setConfirmRevokeId(null);
    });
  };

  const actionDisabled = busy || Boolean(localBusyKey) || !online;

  return (
    <div className="family-device-panel">
      <header className="family-panel-header">
        <div>
          <p className="family-eyebrow">家庭设备</p>
          <h2>管理已授权的设备</h2>
          <p>批准新设备、核对角色，或撤销不再使用的设备。</p>
        </div>
        {onRefresh ? (
          <button
            type="button"
            className="family-button is-secondary"
            onClick={() => void runAction("refresh", onRefresh)}
            disabled={busy || Boolean(localBusyKey)}
          >
            {localBusyKey === "refresh" ? "刷新中…" : "刷新列表"}
          </button>
        ) : null}
      </header>

      {!online ? (
        <p className="family-inline-warning" role="status">
          当前离线：可以查看设备，但不能添加、批准或撤销。
        </p>
      ) : null}
      {localError ? (
        <p className="family-inline-error" role="alert">
          {localError}
        </p>
      ) : null}

      <section className="family-panel-section" aria-labelledby="pending-title">
        <div className="family-panel-title">
          <h3 id="pending-title">待批准申请</h3>
          <span>{pendingRequests.length}</span>
        </div>
        {pendingRequests.length === 0 ? (
          <p className="family-empty-state">暂时没有等待批准的设备。</p>
        ) : (
          <div className="family-request-list">
            {pendingRequests.map((request) => {
              const selectedRole =
                requestRoles[request.requestId] ?? request.requestedRole;
              const isApproving =
                localBusyKey === `approve-${request.requestId}`;
              return (
                <article
                  className="family-request-card"
                  key={request.requestId}
                >
                  <div className="family-request-summary">
                    <span className="family-device-icon" aria-hidden="true">
                      {selectedRole === "parent" ? "🛡️" : "📱"}
                    </span>
                    <div>
                      <h4>{request.deviceName}</h4>
                      <code>{request.deviceId}</code>
                      <p>申请于 {formatDateTime(request.createdAt)}</p>
                    </div>
                  </div>
                  <label className="family-role-select">
                    <span>批准角色</span>
                    <select
                      value={selectedRole}
                      onChange={(event) =>
                        setRequestRoles((current) => ({
                          ...current,
                          [request.requestId]: event.target
                            .value as FamilyDeviceRole,
                        }))
                      }
                      disabled={actionDisabled}
                    >
                      <option value="child">孩子</option>
                      <option value="parent">家长</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="family-button is-primary"
                    onClick={() => void approve(request)}
                    disabled={actionDisabled}
                  >
                    {isApproving ? "批准中…" : "批准设备"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {!automaticRequests ? (
        <section className="family-panel-section" aria-labelledby="add-title">
          <div className="family-panel-title">
            <h3 id="add-title">添加设备申请</h3>
          </div>
          <form className="family-add-request" onSubmit={addRequest}>
            <label>
              <span>设备申请 JSON</span>
              <textarea
                value={requestJson}
                onChange={(event) => setRequestJson(event.target.value)}
                placeholder="粘贴孩子端或新家长端生成的完整申请 JSON"
                rows={5}
                spellCheck={false}
                disabled={actionDisabled}
              />
            </label>
            <p>
              批准前请通过可信方式向家人核对 Device ID；申请中不应包含 GitHub
              Token 或家庭口令。
            </p>
            <button
              type="submit"
              className="family-button is-secondary"
              disabled={actionDisabled || !requestJson.trim()}
            >
              {localBusyKey === "add-request" ? "正在添加…" : "添加到待批准列表"}
            </button>
          </form>
        </section>
      ) : (
        <p className="family-empty-state">
          新设备申请会由 CloudBase 自动出现在上方，无需复制或粘贴 JSON。
        </p>
      )}

      <section className="family-panel-section" aria-labelledby="devices-title">
        <div className="family-panel-title">
          <h3 id="devices-title">设备列表</h3>
          <span>{devices.length}</span>
        </div>
        {sortedDevices.length === 0 ? (
          <p className="family-empty-state">尚无家庭设备。</p>
        ) : (
          <div className="family-device-list">
            {sortedDevices.map((device) => {
              const isCurrent = device.deviceId === currentDeviceId;
              const confirming = confirmRevokeId === device.deviceId;
              const isRevoking =
                localBusyKey === `revoke-${device.deviceId}`;
              return (
                <article className="family-device-row" key={device.deviceId}>
                  <div className="family-device-main">
                    <span className="family-device-icon" aria-hidden="true">
                      {device.role === "parent" ? "🛡️" : "📱"}
                    </span>
                    <div>
                      <h4>
                        {device.deviceName}
                        {isCurrent ? <em>本机</em> : null}
                      </h4>
                      <code>{device.deviceId}</code>
                    </div>
                  </div>
                  <dl className="family-device-meta">
                    <div>
                      <dt>角色</dt>
                      <dd>{roleLabel(device.role)}</dd>
                    </div>
                    <div>
                      <dt>状态</dt>
                      <dd
                        className={`family-device-status is-${device.status}`}
                      >
                        {statusLabel(device.status)}
                      </dd>
                    </div>
                    <div>
                      <dt>最后同步</dt>
                      <dd>{formatDateTime(device.lastSyncedAt)}</dd>
                    </div>
                  </dl>

                  {device.status === "approved" ? (
                    confirming ? (
                      <div
                        className="family-revoke-confirm"
                        role="group"
                        aria-label={`确认撤销 ${device.deviceName}`}
                      >
                        <strong>确认撤销？</strong>
                        <p>撤销后，这台设备将无法再读取或同步家庭数据。</p>
                        <div>
                          <button
                            type="button"
                            className="family-button is-danger"
                            onClick={() => void revoke(device.deviceId)}
                            disabled={actionDisabled}
                          >
                            {isRevoking ? "撤销中…" : "确认撤销"}
                          </button>
                          <button
                            type="button"
                            className="family-button is-quiet"
                            onClick={() => setConfirmRevokeId(null)}
                            disabled={busy || Boolean(localBusyKey)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="family-button is-quiet is-danger-text"
                        onClick={() => setConfirmRevokeId(device.deviceId)}
                        disabled={actionDisabled || isCurrent}
                        title={
                          isCurrent
                            ? "请使用另一台家长设备撤销当前设备"
                            : undefined
                        }
                      >
                        {isCurrent ? "本机不可自撤销" : "撤销设备"}
                      </button>
                    )
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <p className="family-panel-disclaimer">
        家庭非商用 · 非官方产品。访问凭据只应保存在各自设备的本机
        IndexedDB 中；CloudBase 只保存签名配置和端到端加密内容。
      </p>
    </div>
  );
}
