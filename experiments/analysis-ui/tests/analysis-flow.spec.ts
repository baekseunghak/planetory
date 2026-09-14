import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, scenario: string) {
  await page.goto('/?scenario=' + scenario);
  await expect(page.getByRole('button', { name: '다시 풀기', exact: true })).toBeEnabled();
}
const total = (page: Page) => page.getByTestId('recognized-total');

test('last FP correction preserves completion and old history; duplicate adds no reward', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, 'last-fp-wrong');
  await expect(page.locator('.result-status-grid')).toContainText('판단 불일치');
  await expect(page.locator('.page-heading')).toContainText('탐색 완료');
  await expect(total(page)).toHaveText('0');
  await page.getByRole('button', { name: '다시 풀기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '다시 풀기', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeChecked();
  await expect(page.locator('.record-context')).toContainText('mock-bundle-v1');
  await expect(page.locator('.nav-count')).toHaveText('1');
  await page.getByRole('radio', { name: '아닌 것 같음', exact: true }).check();
  await page.getByRole('button', { name: '새 분석으로 제출', exact: true }).click();
  await expect(total(page)).toHaveText('1');
  await expect(page.locator('.result-status-grid')).toContainText('최초 성과 인정');
  await expect(page.locator('.page-heading')).toContainText('탐색 완료');
  await page.getByRole('button', { name: '다시 풀기', exact: true }).click();
  await page.getByRole('radio', { name: '모르겠음', exact: true }).check();
  await page.getByRole('button', { name: '새 분석으로 제출', exact: true }).click();
  await expect(page.locator('.result-status-grid')).toContainText('추가 인정 없음');
  await expect(page.locator('.result-status-grid')).toContainText('판단 보류');
  await expect(total(page)).toHaveText('1');
  await page.getByRole('button', { name: /개인 기록/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.locator('tbody tr').last()).toContainText('행성 같음');
  await expect(page.locator('tbody tr').last()).toContainText('성과 미인정');
  expect(errors).toEqual([]);
});

test('known wrong judgment and UNSURE remain distinct', async ({ page }) => {
  await open(page, 'last-confirmed-wrong');
  await expect(page.locator('.result-status-grid')).toContainText('판단 불일치');
  await page.getByLabel('시나리오', { exact: true }).selectOption('last-confirmed-unsure');
  await expect(page.locator('.result-status-grid')).toContainText('판단 보류');
  await expect(page.locator('.result-status-grid')).not.toContainText('판단 불일치');
  await expect(total(page)).toHaveText('0');
  await expect(page.locator('.statistics-card')).toContainText('성과 인정 참여자의 최신 판단');
  await expect(page.locator('.empty-ai')).toContainText('평가 정보 없음');
});

test('optional publication, partial failure, failed-only retry and latest grade', async ({
  page,
}) => {
  await open(page, 'publication-partial');
  await page.getByRole('button', { name: '공개 내용 검토' }).click();
  await expect(page.locator('.publication-item')).toHaveCount(2);
  await page.getByRole('button', { name: '나중에', exact: true }).click();
  await expect(page.locator('.page-heading')).toContainText('탐색 완료');
  await expect(total(page)).toHaveText('0');
  await page.getByRole('button', { name: '공개 내용 검토' }).click();
  await page.getByRole('button', { name: '모두 게시 (2건)', exact: true }).click();
  await expect(page.locator('.publication-item').first()).toContainText('공개됨');
  await expect(page.locator('.publication-item').last()).toContainText('게시 실패');
  await expect(total(page)).toHaveText('1');
  await expect(page.locator('.publication-item').first().getByRole('checkbox')).toBeDisabled();
  await page.getByRole('button', { name: '실패한 항목 재시도 (1건)', exact: true }).click();
  await expect(page.locator('.publication-item').last()).toContainText('공개됨');
  await expect(total(page)).toHaveText('2');
  await expect(page.locator('.grade.earned')).toHaveText('S');
  await page.getByRole('button', { name: '나중에', exact: true }).click();
  await expect(page.locator('.result-status-grid')).toContainText('공개됨');
  await expect(page.locator('.result-status-grid')).toContainText('최초 성과 인정');
  await page.getByRole('button', { name: '공개 내용 검토' }).click();
  await expect(page.locator('.publication-item')).toHaveCount(0);
});

test('private rejudgment leaves public statistics unchanged until explicit publish', async ({
  page,
}) => {
  await open(page, 'public-statistics');
  await expect(page.locator('.participant-count')).toContainText('15명');
  await expect(page.locator('.distribution-legend li').first()).toContainText('8명');
  await page.getByRole('button', { name: '다시 풀기', exact: true }).click();
  await page.getByRole('radio', { name: '아닌 것 같음', exact: true }).check();
  await page.getByRole('button', { name: '새 분석으로 제출', exact: true }).click();
  await expect(page.locator('.participant-count')).toContainText('15명');
  await expect(page.locator('.distribution-legend li').nth(1)).toContainText('4명');
  await page.getByRole('button', { name: '공개 내용 검토' }).click();
  await page.getByRole('button', { name: '이 분석 게시', exact: true }).click();
  await expect(total(page)).toHaveText('1');
  await page.getByRole('button', { name: '나중에', exact: true }).click();
  await expect(page.locator('.participant-count')).toContainText('16명');
  await expect(page.locator('.distribution-legend li').nth(1)).toContainText('5명');
});

test('detail target, no-target disabled, keyboard dismissal and harmonic original restore', async ({
  page,
}) => {
  await open(page, 'not-matched');
  await expect(page.locator('.statistics-card')).toHaveCount(0);
  await page.getByRole('button', { name: '상세 보기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('제출 곡선의 신호 힌트');
  await expect(page.getByRole('dialog')).toContainText('mock-previous-signal');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByLabel('시나리오', { exact: true }).selectOption('no-hint');
  await expect(page.getByRole('button', { name: '상세 보기', exact: true })).toBeDisabled();
  await page.getByLabel('시나리오', { exact: true }).selectOption('harmonic');
  await expect(page.locator('.correction-note')).toContainText('내 주기 6일');
  await expect(page.locator('.correction-note')).toContainText('대표 주기 3일');
  await page.getByRole('button', { name: '다시 풀기', exact: true }).click();
  await expect(page.locator('.input-values > div').first()).toContainText('6');
});

test('expired Bundle and hidden thread fail without lost completion or leaked thread links', async ({
  page,
}) => {
  await open(page, 'expired-bundle');
  await page.getByRole('button', { name: '다시 풀기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('복원 자료를 사용할 수 없습니다');
  await expect(page.locator('.page-heading')).toContainText('탐색 완료');
  await expect(page.locator('.nav-count')).toHaveText('1');
  await page.getByLabel('시나리오', { exact: true }).selectOption('hidden-thread');
  await page.getByRole('button', { name: '공개 내용 검토' }).click();
  await expect(page.getByRole('alert')).toContainText('현재 공개할 수 없습니다');
  await expect(page.locator('a[href*="thread-"]')).toHaveCount(0);
  await expect(total(page)).toHaveText('0');
});

test('desktop widths fit; keyboard controls work; narrow viewport is gated', async ({ page }) => {
  await open(page, 'last-fp-wrong');
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.getByRole('heading', { name: '분석 결과', exact: true })).toBeVisible();
  }
  const retry = page.getByRole('button', { name: '다시 풀기', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '다시 풀기', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-gate')).toBeVisible();
  await expect(page.locator('.mobile-gate')).toContainText('데스크톱에서이용해 주세요');
  await expect(page.getByRole('button', { name: '새 분석으로 제출' })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('N=0 stays empty and reset starts a new isolated mock session', async ({ page }) => {
  await open(page, 'last-unconfirmed-unpublished');
  await expect(page.locator('.statistics-card')).toContainText('아직 공개된 분석이 없습니다');
  await expect(page.locator('.distribution')).toHaveCount(0);
  await page.getByRole('button', { name: '공개 내용 검토' }).click();
  await page.getByRole('button', { name: '이 분석 게시', exact: true }).click();
  await expect(total(page)).toHaveText('1');
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await expect(page.getByRole('heading', { name: '분석 결과', exact: true })).toBeVisible();
  await expect(total(page)).toHaveText('0');
  await expect(page.locator('.result-status-grid')).toContainText('미게시');
});
