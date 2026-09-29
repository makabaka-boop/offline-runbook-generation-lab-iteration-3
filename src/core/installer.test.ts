import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ChecksumError,
  HttpError,
  InstallerCoordinator,
  QuotaError,
  stageCacheNameFor,
  type InstallerPorts,
  type ManualCacheLike,
} from './installer';
import type { CatalogEntry, PersistedState, ResourceRef, Snapshot } from './types';
import { INITIAL_PERSISTED_STATE } from './types';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const makeRef = (version: string, name: 'manifest.json' | 'faults.json', body: string): ResourceRef => ({
  url: `/manuals/v${version === '1.0.0' ? '1' : '2'}/${name}`,
  sha256: sha(body),
  kind: name === 'manifest.json' ? 'manual' : 'faults',
});

const makeEntry = (version: '1.0.0' | '2.0.0'): { entry: CatalogEntry; bodies: Map<string, string> } => {
  const manifestBody = JSON.stringify({ version, steps: [{ order: 1, action: 'a', detail: 'd' }] });
  const faultsBody = JSON.stringify({ version, entries: [{ id: 'f1', title: 't', actions: [] }] });
  const bodies = new Map<string, string>();
  const r1 = makeRef(version, 'manifest.json', manifestBody);
  const r2 = makeRef(version, 'faults.json', faultsBody);
  bodies.set(r1.url, manifestBody);
  bodies.set(r2.url, faultsBody);
  return {
    entry: {
      version,
      releasedAt: '2026-01-01',
      title: `v${version}`,
      stepCount: 1,
      resources: [r1, r2],
    },
    bodies,
  };
};

type Route =
  | { mode: 'ok' }
  | { mode: 'network' }
  | { mode: 'http' }
  | { mode: 'checksum' }
  | { mode: 'hang' }
  | { mode: 'quotaOnPut' };

interface FakePorts extends InstallerPorts {
  store: PersistedState;
  caches: Map<string, Map<string, { bytes: Uint8Array; contentType: string }>>;
  bodies: Map<string, string>;
  routes: Map<string, Route>;
  calls: string[];
  fetchCalls: { url: string; generation: string }[];
  quota: number | null;
  setRoute(url: string, route: Route): void;
  pendingFetch: Map<string, { reject: (e: unknown) => void; resolve: () => void }>;
}

const enc = new TextEncoder();

const makePorts = (bodies: Map<string, string>): FakePorts => {
  const ports: FakePorts = {
    store: { ...INITIAL_PERSISTED_STATE },
    caches: new Map(),
    bodies,
    routes: new Map(),
    calls: [],
    fetchCalls: [],
    quota: null,
    pendingFetch: new Map(),

    setRoute(url, route) {
      this.routes.set(url, route);
    },

    async loadState() {
      return JSON.parse(JSON.stringify(this.store)) as PersistedState;
    },
    async saveState(state) {
      this.calls.push('save');
      this.store = JSON.parse(JSON.stringify(state)) as PersistedState;
    },

    async fetchResource(ref, signal, generation) {
      this.fetchCalls.push({ url: ref.url, generation });
      const route = this.routes.get(ref.url) ?? { mode: 'ok' };
      if (route.mode === 'network') {
        throw new TypeError('Failed to fetch');
      }
      if (route.mode === 'http') {
        throw new HttpError(500);
      }
      if (route.mode === 'hang') {
        return await new Promise((_resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener('abort', onAbort);
            this.pendingFetch.set(ref.url, {
              reject,
              resolve: () => {
                signal.removeEventListener('abort', onAbort);
                _resolve({ bytes: enc.encode(this.bodies.get(ref.url) ?? '{}'), contentType: 'application/json' });
              },
            });
          }
        });
      }
      let body = this.bodies.get(ref.url) ?? '{}';
      if (route.mode === 'checksum') body = `${body}-tampered`;
      const bytes = enc.encode(body);
      return { bytes, contentType: 'application/json' };
    },

    async sha256(bytes) {
      return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    },

    async openCache(name) {
      let map = this.caches.get(name);
      if (!map) {
        map = new Map();
        this.caches.set(name, map);
      }
      return {
        put: async (url, bytes, contentType) => {
          const route = this.routes.get(url);
          if (route?.mode === 'quotaOnPut') throw new QuotaError();
          map!.set(url, { bytes: new Uint8Array(bytes), contentType });
        },
      };
    },

    async deleteCache(name) {
      return this.caches.delete(name);
    },

    async listManualCaches() {
      return [...this.caches.keys()].filter((k) => k.startsWith('manual:'));
    },

    async readCached(cacheName, url) {
      const item = this.caches.get(cacheName)?.get(url);
      return item ? { bytes: new Uint8Array(item.bytes), contentType: item.contentType } : null;
    },

    async listCacheUrls(cacheName) {
      return [...(this.caches.get(cacheName)?.keys() ?? [])];
    },

    async estimateStorage() {
      if (this.quota === null) return null;
      let usage = 0;
      for (const map of this.caches.values()) {
        for (const item of map.values()) usage += item.bytes.byteLength;
      }
      return { usage, quota: this.quota };
    },

    now: () => 1000,
  };
  return ports;
};

const activeCacheNameOf = (ports: FakePorts) => {
  const name = ports.store.activeCacheName!;
  expect(ports.caches.has(name)).toBe(true);
  return name;
};

const waitFor = async (predicate: () => boolean, label = 'condition') => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时: ${label}`);
};

describe('InstallerCoordinator 状态协调', () => {
  it('首次完整安装：全部资源校验通过后才提交激活，状态为 installing→activated', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    const seen: string[] = [];
    c.subscribe((s) => seen.push(s.status.kind));
    await c.init();

    await c.install(v1.entry);

    expect(ports.store.activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    const cacheName = ports.store.activeCacheName!;
    const cache = ports.caches.get(cacheName)!;
    expect(cache.size).toBe(2);
    // 只有在第二份资源入缓存之后才出现 activated
    expect(seen).toContain('installing');
    expect(seen[seen.length - 1]).toBe('activated');
    // 无多余孤儿缓存
    expect(await ports.listManualCaches()).toEqual([cacheName]);
  });

  it('首次失败：无激活版本，快照显示失败且界面语义为“无可用离线包”', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'network' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    await c.install(v1.entry);

    const snap = c.getSnapshot();
    expect(snap.activeVersion).toBeNull();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(ports.store.activeVersion).toBeNull();
    expect(await ports.listManualCaches()).toEqual([]);
  });

  it('校验失败：标记 checksum，清理未激活缓存，已激活版本保留', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v2.entry.resources[1].url, { mode: 'checksum' });
    await c.install(v2.entry);

    const snap = c.getSnapshot();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(snap.activeVersion).toBe('1.0.0');
    // v2 暂存缓存被清理，v1 激活缓存保留
    expect(ports.caches.has(v1Cache)).toBe(true);
    const stageV2 = [...ports.caches.keys()].filter((k) => k.includes(':2.0.0:'));
    expect(stageV2.length).toBe(0);
  });

  it('断网（下载中途）：标记 network，旧版继续可用', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v2.entry.resources[0].url, { mode: 'network' });
    await c.install(v2.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('配额异常：标记 quota，未激活缓存清理', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'quotaOnPut' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    await c.install(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'quota' });
    expect(ports.store.activeVersion).toBeNull();
    // 配额失败后暂存缓存被整体删除
    expect(ports.caches.size).toBe(0);
  });

  it('取消安装：AbortSignal 中止下载，标记 canceled 且清理暂存缓存', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const done = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing', 'installing');
    expect(c.getSnapshot().status).toMatchObject({ cancelRequested: false });

    await c.cancel();
    await done;

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    expect(ports.store.pending).toBeNull();
    expect(await ports.listManualCaches()).toEqual([]);
  });

  it('安装中关闭后重开：pending 半包被清除，继续展示此前完整版本', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const first = new InstallerCoordinator(ports);
    await first.init();
    await first.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 模拟浏览器在 v2 安装中途被杀掉：IDB 留下 pending，暂存缓存有半包内容。
    const leftover = stageCacheNameFor('2.0.0', 'leftover');
    ports.store = {
      ...ports.store,
      pending: { version: '2.0.0', cacheName: leftover, startedAt: 900, generation: leftover, mode: 'full' },
    };
    const halfCache = new Map<string, { bytes: Uint8Array; contentType: string }>();
    halfCache.set(v2.entry.resources[0].url, { bytes: enc.encode('partial'), contentType: 'application/json' });
    ports.caches.set(leftover, halfCache);

    const reopened = new InstallerCoordinator(ports);
    await reopened.init();
    const snap = reopened.getSnapshot();

    expect(snap.activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    expect(ports.caches.has(leftover)).toBe(false);
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('同版本重装失败：旧激活缓存必须保留，仍展示该完整版本', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v1.entry.resources[0].url, { mode: 'checksum' });
    await c.install(v1.entry);

    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(ports.caches.has(v1Cache)).toBe(true);
    const cachesForV1 = [...ports.caches.keys()].filter((k) => k.includes(':1.0.0:'));
    expect(cachesForV1).toEqual([v1Cache]);
  });

  it('成功升级：新代际激活后旧版缓存与其他孤儿缓存全部回收', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 无关孤儿缓存
    ports.caches.set('manual:stage:2.0.0-orphan', new Map());

    await c.install(v2.entry);

    expect(c.getSnapshot().activeVersion).toBe('2.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'activated' });
    const names = await ports.listManualCaches();
    expect(names).toEqual([ports.store.activeCacheName]);
    expect(names).not.toContain(v1Cache);
  });

  it('重复发起安装被忽略，同一时刻只有一个安装', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const first = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing');
    // 第二次立即返回，不产生新流程
    await c.install(v1.entry);
    await c.cancel();
    await first;
    expect(ports.pendingFetch.size).toBe(1);
  });

  it('订阅者收到不可变快照，失败与激活版本字段一致', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    const snapshots: { active: string | null; status: string }[] = [];
    c.subscribe((s) => snapshots.push({ active: s.activeVersion, status: s.status.kind }));
    await c.init();
    ports.setRoute(v1.entry.resources[0].url, { mode: 'http' });
    await c.install(v1.entry);

    expect(snapshots[0].active).toBeNull();
    const failedSnap = snapshots[snapshots.length - 1];
    expect(failedSnap).toEqual({ active: null, status: 'failed' });
  });
});

/**
 * 按内容摘要复用安装模式。
 * 构造方式：新版本资源可指向“新下载地址”，只要正文 SHA-256 与当前激活版一致，
 * 就应从旧版已核验缓存复制字节，不发起网络请求。
 */
describe('InstallerCoordinator 按内容摘要复用', () => {
  /**
   * 以已激活版本为底，生成一个候选版本：
   * - same：资源正文完全相同（摘要一致），但 URL 可以换成新地址；
   * - change：正文改动（需要联网获取）。
   */
  const makeCandidate = (
    base: { entry: CatalogEntry; bodies: Map<string, string> },
    version: string,
    opts: { manifest: 'same' | 'change'; faults: 'same' | 'change'; urlPrefix: string },
  ) => {
    const bodies = new Map<string, string>();
    const resources: ResourceRef[] = base.entry.resources.map((ref) => {
      const same = ref.kind === 'manual' ? opts.manifest : opts.faults;
      const baseBody = base.bodies.get(ref.url)!;
      const body = same === 'same' ? baseBody : `${baseBody}-${version}-changed`;
      const name = ref.kind === 'manual' ? 'manifest.json' : 'faults.json';
      const url = `${opts.urlPrefix}/${name}`;
      bodies.set(url, body);
      return { url, sha256: sha(body), kind: ref.kind };
    });
    const entry: CatalogEntry = {
      version,
      releasedAt: '2026-09-01',
      title: `candidate ${version}`,
      stepCount: 1,
      resources,
    };
    return { entry, bodies };
  };

  const activate = async (ports: FakePorts, entry: CatalogEntry) => {
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(entry, 'full');
    return c;
  };

  /** 假端口从共享 ports.bodies 取下载正文；把候选正文注入进去。 */
  const seedBodies = (ports: FakePorts, bodies: Map<string, string>) => {
    bodies.forEach((b, url) => ports.bodies.set(url, b));
  };

  it('全部资源摘要一致（仅下载地址变化）：同版离线重放零网络请求，字节逐份复制到新缓存', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 同版本重发布：版本号/正文完全一致，仅下载地址变更（新路径 /manuals/v1r/）。
    const replay = makeCandidate(v1, '1.0.0', { manifest: 'same', faults: 'same', urlPrefix: '/manuals/v1r' });
    const c2 = new InstallerCoordinator(ports);
    await c2.init();
    ports.fetchCalls = [];
    // 完全断网：任何真实下载都应失败。
    replay.bodies.forEach((_b, url) => ports.setRoute(url, { mode: 'network' }));
    // 先记录旧缓存字节（成功激活后旧缓存即被回收）。
    const oldBytes = v1.entry.resources.map((r) => ports.caches.get(v1Cache)!.get(r.url)!.bytes);

    await c2.install(replay.entry, 'reuse');

    const snap = c2.getSnapshot();
    expect(snap.status).toMatchObject({ kind: 'activated', version: '1.0.0' });
    expect(snap.activeVersion).toBe('1.0.0');
    expect(ports.fetchCalls).toEqual([]);
    const newCache = activeCacheNameOf(ports);
    expect(newCache).not.toBe(v1Cache);
    // 新缓存内容逐字节等于旧缓存（即便 URL 不同）。
    replay.entry.resources.forEach((ref, i) => {
      expect(ports.caches.get(newCache)!.get(ref.url)!.bytes).toEqual(oldBytes[i]);
    });
  });

  it('跨版本单项变更：manifest 联网获取，未变的 faults 离线复制（即使地址已变）', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 新版本 manifest 变化（含新版本号），faults 与旧版完全一致。
    const v3 = makeCandidate(v1, '2.0.0', { manifest: 'change', faults: 'same', urlPrefix: '/manuals/v3' });
    // 变化的 manifest 必须是合法的新版本文档（整份清单复核会检查内嵌版本号）。
    const manifestRef = v3.entry.resources.find((r) => r.kind === 'manual')!;
    const validManifest = JSON.stringify({ version: '2.0.0', steps: [{ order: 1, action: 'a2', detail: 'd2' }] });
    v3.bodies.set(manifestRef.url, validManifest);
    manifestRef.sha256 = sha(validManifest);
    seedBodies(ports, v3.bodies);

    const c3 = new InstallerCoordinator(ports);
    await c3.init();
    ports.fetchCalls = [];
    // faults 即便断网也无妨（复用）；只有 manifest 需要网络。
    ports.setRoute(v3.entry.resources.find((r) => r.kind === 'faults')!.url, { mode: 'network' });

    const installingSnaps: Snapshot['status'][] = [];
    c3.subscribe((s) => {
      if (s.status.kind === 'installing') installingSnaps.push(s.status);
    });
    await c3.install(v3.entry, 'reuse');

    expect(c3.getSnapshot().status).toMatchObject({ kind: 'activated' });
    // 只对变化的 manifest 发起一次下载，且请求携带本次代次。
    expect(ports.fetchCalls).toEqual([{ url: manifestRef.url, generation: expect.any(String) }]);
    const last = installingSnaps[installingSnaps.length - 1] as Extract<
      Snapshot['status'],
      { kind: 'installing' }
    >;
    expect(last).toMatchObject({ mode: 'reuse', reusedCount: 1, fetchedCount: 1, completed: 2 });
    // 持久激活后旧缓存已回收，仅新缓存保留（新版不引用旧缓存）。
    expect(await ports.listManualCaches()).toEqual([ports.store.activeCacheName]);
    expect(ports.caches.has(v1Cache)).toBe(false);
  });

  it('复用安装时变化项断网：失败并清理暂存，旧版继续完整可用', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    const v3 = makeCandidate(v1, '2.0.0', { manifest: 'change', faults: 'same', urlPrefix: '/manuals/v3' });
    // 复用项先行处理（1 项），变化项断网失败。
    v3.bodies.forEach((_b, url) => ports.setRoute(url, { mode: 'network' }));
    const c3 = new InstallerCoordinator(ports);
    await c3.init();
    await c3.install(v3.entry, 'reuse');

    const snap = c3.getSnapshot();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(snap.activeVersion).toBe('1.0.0');
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(ports.caches.has(v1Cache)).toBe(true);
    expect(await ports.listManualCaches()).toEqual([v1Cache]);
  });

  it('源缓存字节损坏（摘要不符）：复用判定不命中即联网；下载也失败则整体失败，旧版保留', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 篡改激活缓存全部字节（模拟磁盘损坏）：没有任何摘要可复用。
    for (const ref of v1.entry.resources) {
      ports.caches.get(v1Cache)!.set(ref.url, { bytes: enc.encode('corrupted'), contentType: 'application/json' });
    }

    const v3 = makeCandidate(v1, '2.0.0', { manifest: 'same', faults: 'same', urlPrefix: '/manuals/v3' });
    v3.bodies.forEach((_b, url) => ports.setRoute(url, { mode: 'network' }));
    const c3 = new InstallerCoordinator(ports);
    await c3.init();
    ports.fetchCalls = [];
    await c3.install(v3.entry, 'reuse');

    // 首个资源摘要即不匹配而转联网，断网 -> network 失败（未发生任何复用）；旧版保留。
    expect(c3.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(ports.fetchCalls).toHaveLength(1);
    expect(c3.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('容量预检：暂存区可能超配额时在写入前以 quota 失败，旧版缓存原样保留', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);
    const usedByV1 = [...ports.caches.get(v1Cache)!.values()].reduce((n, i) => n + i.bytes.byteLength, 0);
    // 仅允许旧版占用：同版重放的暂存（与旧版等大）没有任何余量。
    ports.quota = usedByV1;

    const replay = makeCandidate(v1, '1.0.0', { manifest: 'same', faults: 'same', urlPrefix: '/manuals/v1r' });
    const c2 = new InstallerCoordinator(ports);
    await c2.init();
    await c2.install(replay.entry, 'reuse');

    expect(c2.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'quota' });
    expect(c2.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(await ports.listManualCaches()).toEqual([v1Cache]);
  });

  it('复用安装中途取消：已复制项随暂存缓存清理，不留下对旧缓存的引用', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    const v3 = makeCandidate(v1, '2.0.0', { manifest: 'same', faults: 'change', urlPrefix: '/manuals/v3' });
    // manifest 复用先行，faults 变化并挂起，在其等待期间取消。
    ports.setRoute(v3.entry.resources.find((r) => r.kind === 'faults')!.url, { mode: 'hang' });
    const c3 = new InstallerCoordinator(ports);
    await c3.init();

    const done = c3.install(v3.entry, 'reuse');
    await waitFor(() => {
      const s = c3.getSnapshot().status;
      return s.kind === 'installing' && s.reusedCount === 1;
    }, 'reused 1');
    await c3.cancel();
    await done;

    expect(c3.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    expect(c3.getSnapshot().activeVersion).toBe('1.0.0');
    expect(await ports.listManualCaches()).toEqual([v1Cache]);
    expect(ports.store.pending).toBeNull();
  });

  it('复用安装中途重载：pending 半包被清理，旧版继续展示；断网可再次同版复用安装', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 同版重放（仅地址变化），留一个带复用标记的 pending 与部分暂存内容。
    const replay = makeCandidate(v1, '1.0.0', { manifest: 'same', faults: 'same', urlPrefix: '/manuals/v1r' });
    const leftover = stageCacheNameFor('1.0.0', 'stale-gen');
    ports.store = {
      ...ports.store,
      pending: {
        version: '1.0.0',
        cacheName: leftover,
        startedAt: 900,
        generation: 'stale-gen',
        mode: 'reuse',
      },
    };
    const partial = new Map<string, { bytes: Uint8Array; contentType: string }>();
    partial.set(replay.entry.resources[0].url, { bytes: enc.encode('half'), contentType: 'application/json' });
    ports.caches.set(leftover, partial);

    const reopened = new InstallerCoordinator(ports);
    await reopened.init();
    expect(reopened.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    expect(ports.caches.has(leftover)).toBe(false);
    expect(ports.caches.has(v1Cache)).toBe(true);

    // 断网再次复用安装：仍可完整离线成功。
    replay.bodies.forEach((_b, url) => ports.setRoute(url, { mode: 'network' }));
    await reopened.install(replay.entry, 'reuse');
    expect(reopened.getSnapshot().status).toMatchObject({ kind: 'activated' });
    expect(reopened.getSnapshot().activeVersion).toBe('1.0.0');
  });

  it('迟到下载不得激活过期候选：提交前发现 pending 代次已被顶替，只清理自身暂存缓存', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();

    // 旧代次 A：下载挂起在第一资源。
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const installA = c.install(v1.entry, 'full');
    await waitFor(() => c.getSnapshot().status.kind === 'installing', 'A installing');
    const statusA = c.getSnapshot().status as Extract<Snapshot['status'], { kind: 'installing' }>;
    const cacheA = stageCacheNameFor('1.0.0', statusA.generation);

    // 页面重载语义：新协调器 init 清掉 A 的 pending 与暂存缓存；随后完整安装并激活。
    // （A 的挂起下载仍由旧协调器持有，模拟“迟到下载”。）
    const reopened = new InstallerCoordinator(ports);
    await reopened.init();
    expect(ports.caches.has(cacheA)).toBe(false);
    ports.routes.clear();
    await reopened.install(v1.entry, 'full');
    const winnerCache = activeCacheNameOf(ports);

    // A 的挂起下载此刻才返回：A 继续校验/写入自己的暂存缓存，但提交时代次已过期。
    ports.pendingFetch.get(v1.entry.resources[0].url)?.resolve();
    await installA;

    // 激活指针始终属于重载后的新代次；A 没有顶替它，也没有留下孤儿缓存。
    expect(ports.store.activeVersion).toBe('1.0.0');
    expect(ports.store.activeCacheName).toBe(winnerCache);
    expect(await ports.listManualCaches()).toEqual([winnerCache]);
    expect(ports.caches.has(cacheA)).toBe(false);
  });

  it('暂存区整份清单复核：manifest 内部版本与目标不符时以 checksum 失败，旧版保留', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    await activate(ports, v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // “摘要自洽但文档版本错误”的候选：正文声称 9.9.9，清单却登记为 2.0.0。
    const wrongBody = JSON.stringify({ version: '9.9.9', steps: [{ order: 1, action: 'a', detail: 'd' }] });
    const faultsBody = v1.bodies.get(v1.entry.resources[1].url)!;
    const entry: CatalogEntry = {
      version: '2.0.0',
      releasedAt: '2026-09-01',
      title: 'wrong inner version',
      stepCount: 1,
      resources: [
        { url: '/manuals/v3/manifest.json', sha256: sha(wrongBody), kind: 'manual' },
        { url: '/manuals/v3/faults.json', sha256: sha(faultsBody), kind: 'faults' },
      ],
    };
    ports.bodies.set(entry.resources[0].url, wrongBody);
    ports.bodies.set(entry.resources[1].url, faultsBody);

    const c3 = new InstallerCoordinator(ports);
    await c3.init();
    await c3.install(entry, 'full');

    expect(c3.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(c3.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(await ports.listManualCaches()).toEqual([v1Cache]);
  });
});

// 让未使用的类型导入保持显式（ChecksumError 在映射逻辑中间接验证）
void ChecksumError;
