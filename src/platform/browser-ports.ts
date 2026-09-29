/** 浏览器端 InstallerPorts 实现：Cache Storage + fetch + WebCrypto。 */
import type { PersistedState, ResourceRef } from '../core/types';
import {
  HttpError,
  QuotaError,
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

export function createBrowserPorts(): InstallerPorts {
  return {
    loadState: () => readState(),
    saveState: (state: PersistedState) => writeState(state),

    async fetchResource(ref: ResourceRef, signal: AbortSignal) {
      const response = await fetch(ref.url, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
        // 安装专用标记：SW 据此绕过当前激活代际缓存，强制真正下载（离线重装应失败而非读旧缓存）。
        headers: { 'x-manual-install': '1' },
      });
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      const buffer = await response.arrayBuffer();
      return {
        bytes: new Uint8Array(buffer),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
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
            // 用已校验字节重建响应并写入，no-store 避免任何 HTTP 缓存语义影响代际内容。
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

    now: () => Date.now(),
  };
}
