import type { CatalogEntry, FailureCode } from '../core/types';

export interface InstallProgress {
  version: string;
  generation: string;
  mode: 'full' | 'reuse';
  progress: number;
  completed: number;
  total: number;
  reusedCount: number;
  fetchedCount: number;
  cancelRequested: boolean;
}

export interface InstallFailure {
  version: string | null;
  code: FailureCode;
}

export interface ActivatedInfo {
  version: string;
}

export interface InstallControlsProps {
  catalog: CatalogEntry[];
  activeVersion: string | null;
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  activated?: ActivatedInfo | null;
  failureText: Record<FailureCode, string>;
  onInstall: (version: string) => void;
  onCancel: () => void;
}

export function VersionCard({
  entry,
  activeVersion,
  swReady,
  installing,
  failed,
  onInstall,
  onReuse,
  onCancel,
  compact,
}: {
  entry: CatalogEntry;
  activeVersion: string | null;
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  onInstall: (version: string) => void;
  onReuse: (version: string) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const isActive = entry.version === activeVersion;
  const isInstallingThis = installing?.version === entry.version;
  const failedHere = failed?.version === entry.version;
  const busyElsewhere = installing !== null && installing.version !== entry.version;

  return (
    <div className="card" data-testid={`catalog-card-${entry.version}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>
          版本 {entry.version}
          {isActive && (
            <span className="badge active" data-testid={`active-badge-${entry.version}`} style={{ marginLeft: 8 }}>
              当前版
            </span>
          )}
        </strong>
        <span className="small">{entry.releasedAt} 发布</span>
      </div>
      {!compact && <div className="meta">{entry.title}</div>}
      <div className="meta">
        {entry.stepCount} 个有序步骤 · {entry.resources.length} 个同源资源（SHA-256 校验）
      </div>

      {isInstallingThis && installing && (
        <div data-testid={`installing-${entry.version}`}>
          <div className="small">
            {installing.mode === 'reuse' ? (
              <>
                正在按内容摘要安装 {installing.completed}/{installing.total}（{installing.progress}%）：
                复用本机已核验 {installing.reusedCount} 项 · 联网获取 {installing.fetchedCount} 项
              </>
            ) : (
              <>
                正在下载并校验 {installing.completed}/{installing.total}（{installing.progress}%）…
              </>
            )}
            {installing.cancelRequested && ' 正在取消…'}
          </div>
          <div className="progress" data-testid={`progress-${entry.version}`}>
            <span style={{ width: `${installing.progress}%` }} />
          </div>
          <button className="danger" data-testid={`cancel-${entry.version}`} onClick={onCancel}>
            取消安装
          </button>
        </div>
      )}

      {!isInstallingThis && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className={isActive ? '' : 'primary'}
            data-testid={`install-${entry.version}`}
            disabled={!swReady || busyElsewhere}
            onClick={() => onInstall(entry.version)}
          >
            {isActive ? '重新下载并校验（完整重装）' : `完整安装并激活 ${entry.version}`}
          </button>
          <button
            data-testid={`reuse-install-${entry.version}`}
            disabled={!swReady || busyElsewhere || activeVersion === null}
            onClick={() => onReuse(entry.version)}
            title={
              activeVersion === null
                ? '尚无已核验版本可复用，请先完整安装任一版本'
                : '与当前有效版本摘要一致的资源直接复制已核验字节，其余联网获取'
            }
          >
            按内容摘要复用安装{isActive ? '（离线重装）' : ''}
          </button>
        </div>
      )}

      {failedHere && failed && (
        <div className="banner error" data-testid={`fail-${entry.version}`} style={{ marginTop: 10 }}>
          {failureTextOf(failed.code)}
        </div>
      )}
    </div>
  );
}

// 取消由父级统一处理（与安装模式无关）。

const failureTextOf = (code: FailureCode): string => {
  const map: Record<FailureCode, string> = {
    checksum: '资源或清单校验失败（SHA-256 不匹配），未激活缓存已清理',
    network: '下载中断或网络不可用，未激活缓存已清理',
    quota: '存储空间配额异常，未激活缓存已清理',
    canceled: '安装已取消，未激活缓存已清理',
    unknown: '安装发生未知错误，未激活缓存已清理',
  };
  return map[code];
};
