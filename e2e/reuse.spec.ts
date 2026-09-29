import { expect, test } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

/**
 * 按内容摘要复用安装模式的端到端验收：
 * - 断网复用（同版重放，仅地址/代次不同）可离线激活；
 * - 单项变更：未变资源离线复制（SW 不发网络请求），变化资源正常获取；
 * - 校验失败：暂存清理，旧版保留；
 * - 重载恢复：复用安装中途刷新，半包清理、旧版可用，随后可再次成功。
 *
 * 测试夹具：内置 v3 的 faults.json 与 v2 逐字节相同（SHA-256 一致），
 * manifest 不同（v2 为 9 步，v3 为 10 步）。
 */
test.describe('按内容摘要复用安装', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 先完整安装 v2 作为“当前有效版本”。
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-9')).toContainText('接地线并复核保留段');
  });

  test('同版断网复用重放：零下载离线激活到新暂存缓存，旧缓存随后安全回收', async ({ page, context }) => {
    // 完全断网：对同版本执行“按内容摘要复用安装”，应逐字节复制并激活。
    await context.setOffline(true);
    await page.getByTestId('reuse-install-2.0.0').click();

    // 完全断网仍能激活，即证明两项全部来自本机已核验缓存（任何下载都不可能成功）。
    await expect(page.getByTestId('activated-banner')).toContainText('2.0.0');

    // 激活后离线刷新仍可读，且只有一个手册缓存（旧缓存已在持久激活后回收）。
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-9')).toBeVisible();
    const manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((n) => n.startsWith('manual:')),
    );
    expect(manualCaches.length).toBe(1);
    await context.setOffline(false);
  });

  test('单项变更（v3）：faults 摘要一致离线复制、manifest 联网获取，激活后显示 v3', async ({ page, context }) => {
    // 让变化的 manifest 延迟 2 秒正常返回：faults 复用先行，进度稳定停在“复用 1 项”，
    // 随后 manifest 自动到达，无需中途解除故障。
    await setFaultRules(page, [{ match: '/manuals/v3/manifest.json', behavior: 'delay', delayMs: 2000 }]);

    await page.getByTestId('reuse-install-3.0.0').click();
    await expect(page.getByTestId('installing-banner')).toContainText('复用已核验 1 项');
    await expect(page.getByTestId('installing-banner')).toContainText('联网获取 0 项');

    await expect(page.getByTestId('activated-banner')).toContainText('3.0.0');
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
    // v3 有 10 步，第 10 步为本版新增。
    await expect(page.getByTestId('step-10')).toContainText('向调度回令并上传现场复核记录');
    await expect(page.getByTestId('step-9')).toContainText('接地线并复核保留段');

    // 激活后断网刷新：新缓存自包含，不引用旧版缓存；故障演练条目仍可离线搜索。
    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
    await expect(page.getByTestId('step-10')).toBeVisible();
    const manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((n) => n.startsWith('manual:')),
    );
    expect(manualCaches.length).toBe(1);
    await context.setOffline(false);
  });

  test('复用安装校验失败：变化资源被篡改时整体不激活，旧版 v2 完整保留', async ({ page, context }) => {
    // v3 manifest 被篡改：摘要不一致，复用的 faults 已复制也必须整体回滚。
    await setFaultRules(page, [{ match: '/manuals/v3/manifest.json', behavior: 'tamper' }]);
    await page.getByTestId('reuse-install-3.0.0').click();

    await expect(page.getByTestId('failed-banner')).toContainText('校验失败');
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-9')).toBeVisible();
    await expect(page.getByTestId('step-10')).toHaveCount(0);

    // 暂存缓存必须清理，只剩 v2 激活缓存；断网刷新旧版仍完整。
    let manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((n) => n.startsWith('manual:')),
    );
    expect(manualCaches.length).toBe(1);

    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-9')).toBeVisible();
    await context.setOffline(false);
  });

  test('复用安装中途重载：半包被识别清理，旧版可用；再次复用安装成功', async ({ page, context }) => {
    // 让 v3 manifest 永远挂起：faults 复用先行（1/2），安装停在“进行中”后刷新。
    await setFaultRules(page, [{ match: '/manuals/v3/manifest.json', behavior: 'hang' }]);
    await page.getByTestId('reuse-install-3.0.0').click();
    await expect(page.getByTestId('installing-3.0.0')).toContainText('1/2');
    await expect(page.getByTestId('installing-banner')).toContainText('复用已核验 1 项');

    // 安装中刷新（重载恢复）：旧版 v2 继续展示，暂存半包被清理。
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-9')).toBeVisible();
    await expect(page.getByTestId('installing-banner')).toHaveCount(0);
    let manualCaches = await page.evaluate(async () =>
      (await caches.keys()).filter((n) => n.startsWith('manual:')),
    );
    expect(manualCaches.length).toBe(1);

    // 解除挂起，再次复用安装：v3 成功激活；断网刷新确认新缓存自包含。
    await clearFaultRules(page);
    await page.getByTestId('reuse-install-3.0.0').click();
    await expect(page.getByTestId('activated-banner')).toContainText('3.0.0');
    await expect(page.getByTestId('step-10')).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
    await expect(page.getByTestId('step-10')).toBeVisible();
    await context.setOffline(false);
  });
});
