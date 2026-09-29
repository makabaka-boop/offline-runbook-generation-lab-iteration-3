/**
 * 安装状态协调器（框架无关的纯核心，Vitest 直接覆盖）。
 *
 * 不变量：
 * 1. 一个版本的所有资源“全部下载 + SHA-256 校验通过”后，才写入新的激活代际。
 * 2. 半包（pending）在任何路径下都不会被激活；取消、断网、校验失败、配额异常
 *    以及安装中关闭后重开，都只清理该未激活缓存。
 * 3. 已激活的完整版本在失败/中断期间继续保留并可读；从无成功安装则 activeVersion=null，
 *    界面显示“无可用离线包”。
 * 4. IndexedDB 的代际切换先于旧缓存删除（崩溃也只会留下孤儿缓存，下次启动回收）。
 */
import type {
  CatalogEntry,
  FailureCode,
  PersistedState,
  ResourceRef,
  Snapshot,
} from './types';
import { INITIAL_PERSISTED_STATE } from './types';

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}
export class ChecksumError extends Error {
  constructor(public readonly url: string) {
    super(`校验失败: ${url}`);
    this.name = 'ChecksumError';
  }
}
export class QuotaError extends Error {
  constructor() {
    super('配额不足');
    this.name = 'QuotaError';
  }
}
export class Canceled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Canceled';
  }
}

/** 平台端口：浏览器实现由 src/platform 提供，测试用内存假实现。 */
export interface InstallerPorts {
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  /** 下载单个资源；AbortSignal 触发时应拒绝 AbortError/Canceled。 */
  fetchResource(
    ref: ResourceRef,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  sha256(bytes: Uint8Array): Promise<string>;
  openCache(name: string): Promise<ManualCacheLike>;
  deleteCache(name: string): Promise<boolean>;
  /** 列出当前所有代际缓存键名（前缀 manual:）。 */
  listManualCaches(): Promise<string[]>;
  now(): number;
}

export interface ManualCacheLike {
  put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** 每次安装尝试使用唯一暂存缓存名；只有提交后代际指针才指向它。 */
export const stageCacheNameFor = (version: string, attemptId: number | string) =>
  `manual:stage:${version}:${attemptId}`;


type Listener = (snapshot: Snapshot) => void;

const toFailureCode = (err: unknown): FailureCode => {
  if (err instanceof ChecksumError) return 'checksum';
  if (err instanceof Canceled) return 'canceled';
  if (err instanceof QuotaError) return 'quota';
  if (err instanceof HttpError) return 'network';
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || name === 'Canceled') return 'canceled';
    if (
      name === 'QuotaExceededError' ||
      /quota|exceeded/i.test(err.message)
    ) {
      return 'quota';
    }
    if (name === 'TypeError' || name === 'NetworkError') return 'network';
  }
  return 'unknown';
};

const normalizeHash = (hex: string) => hex.trim().toLowerCase().replace(/^sha256-/, '');

export class InstallerCoordinator {
  private state: PersistedState = { ...INITIAL_PERSISTED_STATE };
  private snapshot: Snapshot = { activeVersion: null, status: { kind: 'idle' } };
  private currentController: AbortController | null = null;
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;

  constructor(private readonly ports: InstallerPorts) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private emit() {
    this.snapshot = { activeVersion: this.state.activeVersion, status: this.snapshot.status };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private setStatus(status: Snapshot['status']) {
    this.snapshot = { activeVersion: this.state.activeVersion, status };
    this.emit();
  }

  /**
   * 启动恢复：若存在 pending 半包（含“安装中关闭后重开”），丢弃其缓存与状态，
   * 继续展示此前的完整版本；若无完整版本则界面显示“无可用离线包”。
   * 同时回收任何不属于当前激活代际的孤儿缓存。
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initOnce();
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    const state = await this.ports.loadState();
    if (state.pending) {
      await this.safeDelete(state.pending.cacheName);
      state.pending = null;
      await this.ports.saveState(state);
    }
    this.state = state;
    await this.reconcileCaches();
    this.snapshot = { activeVersion: state.activeVersion, status: { kind: 'idle' } };
    this.emit();
  }

  private async reconcileCaches() {
    const keep = this.state.activeCacheName;
    let names: string[] = [];
    try {
      names = await this.ports.listManualCaches();
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name !== keep && name.startsWith('manual:'))
        .map((name) => this.safeDelete(name)),
    );
  }

  private async safeDelete(name: string) {
    try {
      await this.ports.deleteCache(name);
    } catch {
      // 删除失败不改变状态正确性：该缓存既不在 IDB 中被引用，后续仍会被回收。
    }
  }

  async install(entry: CatalogEntry): Promise<void> {
    if (this.currentController) {
      // 同一时间只允许一个安装；重复点击直接忽略。
      return;
    }
    const total = entry.resources.length;
    const version = entry.version;
    // 每次尝试使用全新暂存缓存：即便与当前激活版本相同，也绝不先破坏旧版。
    const cacheName = stageCacheNameFor(version, `${this.ports.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const controller = new AbortController();
    this.currentController = controller;

    // 清理可能的同名残留（理论上唯一，防御性处理）。
    await this.safeDelete(cacheName);

    this.state = {
      ...this.state,
      pending: { version, cacheName, startedAt: this.ports.now() },
    };
    await this.ports.saveState(this.state);
    this.setStatus({
      kind: 'installing',
      version,
      progress: 0,
      completed: 0,
      total,
      cancelRequested: false,
    });

    try {
      const cache = await this.ports.openCache(cacheName);
      for (let i = 0; i < entry.resources.length; i++) {
        if (controller.signal.aborted) throw new Canceled();
        const ref = entry.resources[i];
        const { bytes, contentType } = await this.ports.fetchResource(ref, controller.signal);
        if (controller.signal.aborted) throw new Canceled();
        const actual = normalizeHash(await this.ports.sha256(bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        await cache.put(ref.url, bytes, contentType);
        if (controller.signal.aborted) throw new Canceled();
        this.setStatus({
          kind: 'installing',
          version,
          completed: i + 1,
          total,
          progress: Math.round(((i + 1) / total) * 100),
          cancelRequested: false,
        });
      }

      // 原子切换：全部资源校验入缓存后才提交新代际。
      this.state = {
        activeVersion: version,
        activeCacheName: cacheName,
        pending: null,
      };
      await this.ports.saveState(this.state);

      // 代际已提交，再回收旧版与任何其他孤儿缓存（仅保留新激活缓存）。
      await this.reconcileCaches();

      this.setStatus({ kind: 'activated', version });
    } catch (err) {
      await this.failInstallation(version, cacheName, err);
    } finally {
      this.currentController = null;
    }
  }

  private async failInstallation(failedVersion: string, failedCacheName: string, err: unknown) {
    const code = toFailureCode(err);
    // 失败绝不触碰已激活代际；只登记并清除本次未激活缓存。
    this.state = { ...this.state, pending: null };
    await this.ports.saveState(this.state);
    await this.safeDelete(failedCacheName);
    await this.reconcileCaches();
    this.setStatus({ kind: 'failed', version: failedVersion, code });
  }

  async cancel(): Promise<void> {
    const controller = this.currentController;
    if (!controller || controller.signal.aborted) return;
    const status = this.snapshot.status;
    if (status.kind === 'installing') {
      this.setStatus({ ...status, cancelRequested: true });
    }
    controller.abort();
  }
}
