/**
 * 安装状态协调器（框架无关的纯核心，Vitest 直接覆盖）。
 *
 * 不变量：
 * 1. 一个版本的所有资源“全部就位 + SHA-256 校验通过 + 整份清单复核通过”后，
 *    才写入新的激活代际。任何半包（pending）在任何路径下都不会被激活。
 * 2. 取消、断网、校验失败、配额异常以及安装中关闭后重开，都只清理该未激活缓存；
 *    已激活的完整版本在失败/中断期间继续保留并可读；从无成功安装则
 *    activeVersion=null，界面显示“无可用离线包”。
 * 3. IndexedDB 的代际切换先于旧缓存删除（崩溃也只会留下孤儿缓存，下次启动回收）；
 *    旧版回收只能发生在新版本持久激活之后。
 * 4. 安装代次（generation）：每次发起安装都唯一。缓存、版本元数据与进度界面
 *    围绕同一代次裁决；旧代次的迟到下载即使完成，提交前发现代次已过期也只能清理
 *    自己的暂存缓存，绝不能激活过期候选。
 * 5. reuse 模式仅“复制”旧版已核验字节到新暂存缓存，不共享/不引用旧缓存：
 *    新版本激活后旧缓存即可安全回收，不会因旧版清理而离线缺件。
 */
import type {
  CatalogEntry,
  FailureCode,
  InstallMode,
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

export interface CachedResource {
  bytes: Uint8Array;
  contentType: string;
}

/** 平台端口：浏览器实现由 src/platform 提供，测试用内存假实现。 */
export interface InstallerPorts {
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  /**
   * 下载单个资源；AbortSignal 触发时应拒绝 AbortError/Canceled。
   * generation 为本次安装代次，浏览器实现以请求头透传给 SW 做代次裁决。
   */
  fetchResource(
    ref: ResourceRef,
    signal: AbortSignal,
    generation: string,
  ): Promise<CachedResource>;
  sha256(bytes: Uint8Array): Promise<string>;
  openCache(name: string): Promise<ManualCacheLike>;
  deleteCache(name: string): Promise<boolean>;
  /** 列出当前所有代际缓存键名（前缀 manual:）。 */
  listManualCaches(): Promise<string[]>;
  /** 读取某缓存中的单个条目（reuse 复制与暂存区复核用）；不存在返回 null。 */
  readCached(cacheName: string, url: string): Promise<CachedResource | null>;
  /** 列出某缓存内全部条目 URL。 */
  listCacheUrls(cacheName: string): Promise<string[]>;
  /** 存储配额估算；无法估算时返回 null（跳过容量预检）。 */
  estimateStorage(): Promise<{ usage: number; quota: number } | null>;
  now(): number;
}

export interface ManualCacheLike {
  put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** 每次安装尝试使用唯一暂存缓存名（编码代次）；只有提交后代际指针才指向它。 */
export const stageCacheNameFor = (version: string, generation: number | string) =>
  `manual:stage:${version}:${generation}`;

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

interface Progress {
  completed: number;
  reused: number;
  fetched: number;
}

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

  private emitProgress(
    version: string,
    generation: string,
    mode: InstallMode,
    total: number,
    p: Progress,
    cancelRequested: boolean,
  ) {
    const status: Snapshot['status'] = {
      kind: 'installing',
      version,
      generation,
      mode,
      completed: p.completed,
      total,
      reusedCount: p.reused,
      fetchedCount: p.fetched,
      progress: Math.round((p.completed / total) * 100),
      cancelRequested,
    };
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

  /**
   * 安装入口（保留两种模式）：
   * - full：完整安装，每项资源重新下载校验；
   * - reuse：按内容摘要复用当前激活版本中 SHA-256 完全一致的已核验字节，
   *   其余资源照常获取。
   */
  async install(entry: CatalogEntry, mode: InstallMode = 'full'): Promise<void> {
    if (this.currentController) {
      // 同一时间只允许一个安装；重复点击直接忽略。
      return;
    }
    const total = entry.resources.length;
    const version = entry.version;
    // 每次尝试使用全新代次与暂存缓存：即便与当前激活版本相同，也绝不先破坏旧版。
    const generation = `${this.ports.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cacheName = stageCacheNameFor(version, generation);
    const controller = new AbortController();
    this.currentController = controller;

    // 清理可能的同名残留（理论上唯一，防御性处理）。
    await this.safeDelete(cacheName);

    this.state = {
      ...this.state,
      pending: {
        version,
        cacheName,
        startedAt: this.ports.now(),
        generation,
        mode,
      },
    };
    await this.ports.saveState(this.state);
    const progress: Progress = { completed: 0, reused: 0, fetched: 0 };
    this.emitProgress(version, generation, mode, total, progress, false);

    try {
      const cache = await this.ports.openCache(cacheName);

      // reuse：扫描当前激活缓存，按“内容摘要”建立复用索引（与 URL 无关，
      // 因此新版本即使下载地址变化也能复用）。
      const reusable = new Map<string, CachedResource>();
      const sourceCacheName = this.state.activeCacheName;
      if (mode === 'reuse' && sourceCacheName) {
        for (const url of await this.ports.listCacheUrls(sourceCacheName)) {
          if (controller.signal.aborted) throw new Canceled();
          const item = await this.ports.readCached(sourceCacheName, url);
          if (!item) continue;
          const digest = normalizeHash(await this.ports.sha256(item.bytes));
          if (!reusable.has(digest)) reusable.set(digest, item);
        }
      }

      // 容量预检（无法估算的平台跳过；put 时仍可能抛 QuotaError，走同一失败路径）。
      const estimate = await this.ports.estimateStorage();
      let stagedBytes = 0;
      const ensureCapacity = (byteCount: number) => {
        if (!estimate) return;
        // usage 已含旧激活缓存；暂存字节是额外占用，失败时旧版原样保留。
        const available = estimate.quota - Math.min(estimate.usage, estimate.quota) - stagedBytes;
        if (byteCount > available) throw new QuotaError();
      };

      const stageOne = async (ref: ResourceRef, via: 'reuse' | 'fetch') => {
        if (controller.signal.aborted) throw new Canceled();
        let item: CachedResource;
        if (via === 'reuse') {
          const found = reusable.get(normalizeHash(ref.sha256));
          if (!found) throw new ChecksumError(ref.url);
          item = found;
        } else {
          item = await this.ports.fetchResource(ref, controller.signal, generation);
        }
        if (controller.signal.aborted) throw new Canceled();
        // 无论复制还是下载，写入前都重新以新清单摘要核验。
        const actual = normalizeHash(await this.ports.sha256(item.bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        ensureCapacity(item.bytes.byteLength);
        await cache.put(ref.url, item.bytes, item.contentType);
        stagedBytes += item.bytes.byteLength;
        if (controller.signal.aborted) throw new Canceled();
        progress.completed += 1;
        if (via === 'reuse') progress.reused += 1;
        else progress.fetched += 1;
        this.emitProgress(version, generation, mode, total, progress, false);
      };

      // 先处理可复用项：离线场景下最大化已核验进度，变化项随后正常获取。
      const refs = entry.resources;
      const reuseRefs = refs.filter((r) => reusable.has(normalizeHash(r.sha256)));
      const fetchRefs = refs.filter((r) => !reusable.has(normalizeHash(r.sha256)));
      for (const ref of reuseRefs) {
        await stageOne(ref, 'reuse');
      }
      for (const ref of fetchRefs) {
        await stageOne(ref, 'fetch');
      }

      // 暂存区逐项复核 + 整份清单复核：数量、URL 集合、逐项 SHA-256，
      // 以及清单版本与文档结构。全部通过才允许提交。
      await this.verifyStage(entry, cacheName);

      // 代次裁决：提交前重新读取持久化状态。若本次 pending 已不是当前代次
      // （取消/重载/其他代次抢先），迟到下载只能清理自己的暂存缓存，禁止激活。
      const persisted = await this.ports.loadState();
      if (persisted.pending?.generation !== generation) {
        await this.safeDelete(cacheName);
        return;
      }

      // 原子切换：全部复核通过后才提交新代际指针。
      this.state = {
        activeVersion: version,
        activeCacheName: cacheName,
        pending: null,
      };
      await this.ports.saveState(this.state);

      // 新版本已持久激活，此后才回收旧版与任何其他孤儿缓存。
      await this.reconcileCaches();

      this.snapshot = {
        activeVersion: version,
        status: { kind: 'activated', version, generation },
      };
      this.emit();
    } catch (err) {
      await this.failInstallation(version, cacheName, generation, err);
    } finally {
      this.currentController = null;
    }
  }

  /**
   * 对暂存区做最终复核：
   * - 条目数量与 URL 集合必须与新清单完全一致（不多不少）；
   * - 每项内容重新计算 SHA-256，必须与清单登记一致；
   * - manifest.json 必须可解析、版本与目标版本一致；
   * - faults.json 必须可解析且含有序条目数组。
   * 任一不符抛 ChecksumError，归入 checksum 失败路径。
   */
  private async verifyStage(entry: CatalogEntry, cacheName: string): Promise<void> {
    const urls = new Set(await this.ports.listCacheUrls(cacheName));
    if (urls.size !== entry.resources.length) {
      throw new ChecksumError(`暂存条目数量不符: ${urls.size}/${entry.resources.length}`);
    }
    for (const ref of entry.resources) {
      if (!urls.has(ref.url)) throw new ChecksumError(ref.url);
      const item = await this.ports.readCached(cacheName, ref.url);
      if (!item) throw new ChecksumError(ref.url);
      const actual = normalizeHash(await this.ports.sha256(item.bytes));
      if (actual !== normalizeHash(ref.sha256)) throw new ChecksumError(ref.url);

      if (ref.kind === 'manual') {
        let doc: { version?: unknown; steps?: unknown };
        try {
          doc = JSON.parse(new TextDecoder().decode(item.bytes));
        } catch {
          throw new ChecksumError(ref.url);
        }
        if (doc.version !== entry.version || !Array.isArray(doc.steps) || doc.steps.length === 0) {
          throw new ChecksumError(ref.url);
        }
      }
      if (ref.kind === 'faults') {
        let doc: { entries?: unknown };
        try {
          doc = JSON.parse(new TextDecoder().decode(item.bytes));
        } catch {
          throw new ChecksumError(ref.url);
        }
        if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
          throw new ChecksumError(ref.url);
        }
      }
    }
  }

  private async failInstallation(
    failedVersion: string,
    failedCacheName: string,
    generation: string,
    err: unknown,
  ) {
    // 重新读取持久化状态做代次裁决：若该代次已失效（重载/其他代次接管），
    // 本次失败只清理自己的暂存缓存，不改写当前状态、不冒发失败界面。
    let current: PersistedState;
    try {
      current = await this.ports.loadState();
    } catch {
      current = this.state;
    }
    const stale = current.pending?.generation !== generation;
    if (stale) {
      await this.safeDelete(failedCacheName);
      return;
    }

    const code = toFailureCode(err);
    // 失败绝不触碰已激活代际；只登记并清除本次未激活缓存。
    this.state = { ...this.state, pending: null };
    await this.ports.saveState(this.state);
    await this.safeDelete(failedCacheName);
    await this.reconcileCaches();
    this.snapshot = {
      activeVersion: this.state.activeVersion,
      status: { kind: 'failed', version: failedVersion, code },
    };
    this.emit();
  }

  async cancel(): Promise<void> {
    const controller = this.currentController;
    if (!controller || controller.signal.aborted) return;
    const status = this.snapshot.status;
    if (status.kind === 'installing') {
      this.emitProgress(
        status.version,
        status.generation,
        status.mode,
        status.total,
        { completed: status.completed, reused: status.reusedCount, fetched: status.fetchedCount },
        true,
      );
    }
    controller.abort();
  }
}
