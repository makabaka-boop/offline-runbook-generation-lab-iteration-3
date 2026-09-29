/** 手册手册域的共享类型定义（无 DOM 依赖，可在 SW 与测试中使用）。 */

/** 清单中单个同源资源的引用：URL + SHA-256 完整性。 */
export interface ResourceRef {
  url: string;
  sha256: string;
  kind: 'manual' | 'faults';
}

/** 手册版本清单（含版本号、同源资源、有序步骤与故障条目）。 */
export interface ManualManifest {
  version: string;
  releasedAt: string;
  title: string;
  steps: OrderedStep[];
}

export interface OrderedStep {
  order: number;
  action: string;
  detail: string;
}

export interface FaultEntry {
  id: string;
  title: string;
  keywords: string[];
  symptoms: string;
  actions: string[];
}

/** 内置手册目录中的一个版本条目（清单：版本号 + 同源 URL + SHA-256 + 有序步骤数）。 */
export interface CatalogEntry {
  version: string;
  releasedAt: string;
  title: string;
  stepCount: number;
  resources: ResourceRef[];
}

/** 安装失败原因分类。 */
export type FailureCode =
  | 'checksum' // 校验失败
  | 'network' // 断网 / 下载失败
  | 'quota' // 配额异常
  | 'canceled' // 取消
  | 'unknown';

/**
 * 安装模式：
 * - full：保留的完整安装入口，每项资源一律重新下载并校验；
 * - reuse：按内容摘要复用。新清单中 SHA-256 与当前激活版本完全一致的资源，
 *   从旧版已核验缓存“复制字节”到新版本专属暂存区；其余资源照常下载。
 */
export type InstallMode = 'full' | 'reuse';

export const FAILURE_TEXT: Record<FailureCode, string> = {
  checksum: '资源校验失败（SHA-256 不匹配），已丢弃本版缓存',
  network: '下载中断或网络不可用，已丢弃本版缓存',
  quota: '存储空间配额异常，已丢弃本版缓存',
  canceled: '安装已取消，未激活缓存已清理',
  unknown: '安装发生未知错误，未激活缓存已清理',
};

/** IndexedDB 中唯一持久化的记录（当前代际与安装状态）。 */
export interface PersistedState {
  /** 当前已激活的完整版本；从未成功安装时为 null。 */
  activeVersion: string | null;
  /** 已激活版本缓存的 Cache Storage 键名。 */
  activeCacheName: string | null;
  /**
   * 正在进行中的安装（用于关闭后重开时识别“半包”）。
   * 一旦存在即视为中断残留，启动时清理并永不激活。
   */
  pending: {
    version: string;
    cacheName: string;
    startedAt: number;
    /**
     * 安装代次：每次发起安装都唯一。SW 缓存、版本元数据与进度界面围绕同一代次裁决，
     * 旧代次的迟到下载即便完成也不得提交。持久化字段（旧记录缺失时按 cacheName 兜底）。
     */
    generation: string;
    /** full：完整下载；reuse：按摘要复用旧版已核验字节。 */
    mode: InstallMode;
  } | null;
}

export const INITIAL_PERSISTED_STATE: PersistedState = {
  activeVersion: null,
  activeCacheName: null,
  pending: null,
};

export type InstallerStatus =
  | { kind: 'idle' }
  | {
      kind: 'installing';
      version: string;
      /** 本次安装的唯一代次（迟到下载只可能停留在旧代次，永不激活）。 */
      generation: string;
      /** full 或 reuse。 */
      mode: InstallMode;
      /** 0–100 的整数进度。 */
      progress: number;
      completed: number;
      total: number;
      /** reuse 模式下从当前激活版本逐字节复制的资源数。 */
      reusedCount: number;
      /** 实际走网络获取的资源数。 */
      fetchedCount: number;
      cancelRequested: boolean;
    }
  | { kind: 'activated'; version: string; generation: string }
  | { kind: 'failed'; version: string | null; code: FailureCode };

export interface Snapshot {
  activeVersion: string | null;
  status: InstallerStatus;
}
