/** 浏览器端 InstallerPorts 实现：Cache Storage + fetch + WebCrypto。 */
import type { PersistedState, ResourceRef } from '../core/types';
import {
  HttpError,
  QuotaError,
  type CachedResource,
  type InstallerPorts,
  type ManualCacheLike,
} from '../core/installer';
import { readState, writeState } from '../core/idb';

const isQuotaError = (err: unknown): boolean => {
  if (!err) return false;
  const e = err as { name?: string; message?: string; code?: number };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (typeof e.code === 'number' && e.code === 22) ||
    /quota|exceeded/i.test(e.message ?? '')
  );
};

const readResponse = async (response: Response): Promise<CachedResource> => {
  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
};

export function createBrowserPorts(): InstallerPorts {
  return {
    loadState: () => readState(),
    saveState: (state: PersistedState) => writeState(state),

    async fetchResource(ref: ResourceRef, signal: AbortSignal, generation: string) {
      const response = await fetch(ref.url, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
        // 安装专用标记：SW 据此绕过当前激活代际缓存，强制真正下载（离线重装应失败而非读旧缓存）。
        // 代次标记随请求透传，SW、缓存与版本元数据围绕同一安装代次裁决。
        headers: { 'x-manual-install': '1', 'x-manual-generation': generation },
      });
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      return readResponse(response);
    },

    async sha256(bytes: Uint8Array) {
      const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    },

    async openCache(name: string): Promise<ManualCacheLike> {
      const cache = await caches.open(name);
      return {
        async put(url: string, bytes: Uint8Array, contentType: string) {
          try {
            // 用已核验字节重建响应并写入，no-store 避免任何 HTTP 缓存语义影响代际内容。
            const response = new Response(bytes as BodyInit, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
              },
            });
            await cache.put(url, response);
          } catch (err) {
            if (isQuotaError(err)) throw new QuotaError();
            throw err;
          }
        },
      };
    },

    deleteCache: (name: string) => caches.delete(name),

    async listManualCaches() {
      const keys = await caches.keys();
      return keys.filter((k) => k.startsWith('manual:'));
    },

    async readCached(cacheName: string, url: string): Promise<CachedResource | null> {
      // 直接对指定缓存 match：复用读取绝不经过 SW，因此离线可用，且永远只读到
      // 调用方点名的那一代缓存（激活版），不会触碰任何暂存/半包缓存。
      const cache = await caches.open(cacheName);
      const hit = await cache.match(url, { ignoreSearch: false });
      if (!hit) return null;
      return readResponse(hit);
    },

    async listCacheUrls(cacheName: string): Promise<string[]> {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      return requests.map((r) => r.url).map((u) => {
        try {
          return new URL(u, self.location.origin).pathname;
        } catch {
          return u;
        }
      });
    },

    async estimateStorage() {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
      try {
        const estimate = await navigator.storage.estimate();
        if (typeof estimate.quota !== 'number') return null;
        return { usage: estimate.usage ?? 0, quota: estimate.quota };
      } catch {
        return null;
      }
    },

    now: () => Date.now(),
  };
}
