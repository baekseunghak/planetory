import { expect, test, type Locator, type Page } from '@playwright/test';

const storageKey = 'planetory.observation-drafts.v1';
const targets = [
  { id: 'toi270', count: 44_551 },
  { id: 'l98-59', count: 47_579 },
  { id: 'cm-dra', count: 11_558 },
] as const;
const folded = (page: Page) => page.getByRole('group', { name: '접힌 광도곡선', exact: true });
const peak = (page: Page, rank = 1) =>
  page.getByRole('button', { name: new RegExp(`^봉우리 ${rank} ·`) });

async function openObservation(page: Page, target = 'toi270') {
  await page.goto(`/?mode=observations&target=${target}`);
  await expect(peak(page)).toBeVisible();
  await expect(page.getByRole('group', { name: '시간 영역 광도곡선', exact: true })).toBeVisible();
}

async function choosePeak(page: Page, rank = 1) {
  await peak(page, rank).click();
  await expect(folded(page)).toHaveAttribute('aria-disabled', 'false');
  await expect(peak(page, rank)).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: '이 주기로 구간 고르기', exact: true }),
  ).toBeEnabled();
}

async function chooseCentralInterval(page: Page) {
  await page.getByRole('button', { name: '이 주기로 구간 고르기', exact: true }).click();
  await page.getByRole('button', { name: '중앙 구간에서 시작', exact: true }).click();
  await expect(page.getByTestId('phase-selection')).not.toContainText('구간을 선택하세요');
  await expect(
    page.getByRole('button', { name: '이 구간으로 판단하기', exact: true }),
  ).toBeEnabled();
}

async function chooseJudgment(
  page: Page,
  judgment = '행성 같음',
  memo = '반복되는 어두워짐을 확인함',
) {
  await page.getByRole('button', { name: '이 구간으로 판단하기', exact: true }).click();
  await page.getByRole('radio', { name: judgment, exact: true }).check();
  await page.getByRole('textbox', { name: '관찰 메모', exact: true }).fill(memo);
}

async function dragRatios(page: Page, chart: Locator, start: number, end: number) {
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error('관측 그래프의 화면 영역이 없습니다.');
  const y = box.y + box.height * 0.6;
  await page.mouse.move(box.x + box.width * start, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end, y, { steps: 8 });
  await page.mouse.up();
}

async function storedRecords(page: Page) {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]'), storageKey);
}

async function installControlledWorker(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const control = { failNext: false, delayNext: false, delayedReady: 0, deliveredLate: 0 };
    Object.assign(window, { observationWorkerControl: control });
    class ControlledWorker extends EventTarget {
      private native: Worker;
      private delayed = false;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor(url: string | URL, options?: WorkerOptions) {
        super();
        this.native = new NativeWorker(url, options);
        this.native.onmessage = (event) => {
          if (this.delayed) {
            control.delayedReady++;
            // Model an already queued old reply, even after its worker was terminated.
            setTimeout(() => {
              control.deliveredLate++;
              this.onmessage?.(event);
            }, 700);
          } else this.onmessage?.(event);
        };
        this.native.onerror = (event) => this.onerror?.(event);
      }
      postMessage(message: unknown) {
        if (control.failNext) {
          control.failNext = false;
          queueMicrotask(() =>
            this.onerror?.(new ErrorEvent('error', { message: 'Injected worker failure' })),
          );
          return;
        }
        this.delayed = control.delayNext;
        control.delayNext = false;
        this.native.postMessage(message);
      }
      terminate() {
        this.native.terminate();
      }
    }
    window.Worker = ControlledWorker as unknown as typeof Worker;
  });
}

for (const target of targets) {
  test(`${target.id}: loads and folds all ${target.count} real observation points`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/observations/${target.id}.json`),
    );
    await openObservation(page, target.id);
    const data = await (await responsePromise).json();
    expect(data.time_btjd).toHaveLength(target.count);
    expect(data.normalized_flux).toHaveLength(target.count);
    const timeChart = page.getByRole('group', { name: '시간 영역 광도곡선', exact: true });
    await expect(timeChart).toHaveAttribute('data-point-count', String(target.count));
    await choosePeak(page);
    await expect(folded(page)).toHaveAttribute('data-point-count', String(target.count));
    expect(
      await folded(page)
        .locator('canvas')
        .evaluate((canvas: HTMLCanvasElement) => {
          const pixels = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let coloredPixels = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 1] > pixels[i] && pixels[i + 3] > 0) coloredPixels++;
          return coloredPixels;
        }),
    ).toBeGreaterThan(target.count / 10);
    await expect(page.locator('.observation-footer')).toContainText(
      '서버 제출 시 재계산이 필요합니다',
    );
    expect(errors).toEqual([]);
  });
}

test('selection, judgment, tab storage and refresh restore preserve the immutable original', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
  });
  await openObservation(page);
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeDisabled();
  await choosePeak(page);
  await folded(page).focus();
  await page.keyboard.press('Equal');
  await expect(page.getByTestId('fold-zoom')).toHaveText('×2');
  await chooseCentralInterval(page);
  await expect(page.getByTestId('epoch-preview')).not.toHaveText('—');
  await expect(page.getByTestId('duration-preview')).not.toHaveText('—');
  await expect(
    page
      .getByRole('group', { name: '시간 영역 광도곡선', exact: true })
      .locator('.transit-band')
      .first(),
  ).toBeVisible();
  await chooseJudgment(page);
  await page.getByRole('button', { name: '선택값 검토', exact: true }).click();
  await expect(page.locator('.review-card')).toContainText('매칭·성과·공개는 처리하지 않습니다');
  await page.getByRole('button', { name: '브라우저에 임시 저장', exact: true }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText(
    '실제 제출·매칭·성과 처리는 아직 연결되지 않았습니다',
  );
  const [original] = await storedRecords(page);
  expect(original).toMatchObject({
    status: 'LOCAL_DRAFT',
    observation_id: 'toi270',
    curve_step: 0,
    retry_of: null,
    user_judgment: 'LIKELY_PLANET',
    memo: '반복되는 어두워짐을 확인함',
    view: { zoom: 2, center: 0 },
  });
  expect(original.selection.phase_start).toBeCloseTo(0.98, 10);
  expect(original.selection.phase_end).toBeCloseTo(1.02, 10);
  await page.reload();
  await expect(peak(page)).toBeVisible();
  await page.getByRole('button', { name: /^임시 기록/ }).click();
  await expect(page.locator('.draft-records tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '입력 복원', exact: true }).click();
  await expect(page.locator('.review-card')).toContainText('복원한 입력을 새 기록으로 저장합니다');
  await expect(page.getByLabel('주기 (일)', { exact: true })).toHaveValue(
    String(original.selection.period_days),
  );
  await expect(page.getByTestId('fold-zoom')).toHaveText('×2');
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: '관찰 메모', exact: true })).toHaveValue(
    original.memo,
  );
  expect(await storedRecords(page)).toEqual([original]);
  await page.getByRole('radio', { name: '모르겠음', exact: true }).check();
  await page
    .getByRole('textbox', { name: '관찰 메모', exact: true })
    .fill('다시 보니 더 확인이 필요함');
  await page.getByRole('button', { name: '선택값 검토', exact: true }).click();
  await page.getByRole('button', { name: '브라우저에 임시 저장', exact: true }).click();
  const records = await storedRecords(page);
  expect(records).toHaveLength(2);
  expect(records[1]).toEqual(original);
  expect(records[0].id).not.toBe(original.id);
  expect(records[0].retry_of).toBe(original.id);
  expect(records[0].selection).toEqual(original.selection);
  expect(records[0].user_judgment).toBe('UNSURE');
  expect(mutations).toEqual([]);
});

test('fine period clears dependent inputs, keeps zoom, and does not request BLS; another peak resets zoom', async ({
  page,
}) => {
  await openObservation(page);
  await choosePeak(page);
  await folded(page).focus();
  await page.keyboard.press('Equal');
  await page.keyboard.press('Equal');
  await expect(page.getByTestId('fold-zoom')).toHaveText('×4');
  await chooseCentralInterval(page);
  await chooseJudgment(page);
  const period = page.getByLabel('주기 (일)', { exact: true });
  const newValue = String(
    Number(await period.inputValue()) +
      Number(await page.locator('#fine-period').getAttribute('step')),
  );
  const dataRequests: string[] = [];
  page.on('request', (request) => {
    if (
      ['fetch', 'xhr'].includes(request.resourceType()) ||
      /\/api\/|\/bls(?:[/?]|$)/i.test(request.url())
    )
      dataRequests.push(request.url());
  });
  await period.fill(newValue);
  await period.press('Enter');
  await expect(folded(page)).toHaveAttribute('aria-disabled', 'false');
  await expect(period).toHaveValue(newValue);
  await expect(page.getByTestId('phase-selection')).toHaveText('구간을 선택하세요');
  await expect(page.getByTestId('epoch-preview')).toHaveText('—');
  await expect(page.getByTestId('fold-zoom')).toHaveText('×4');
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '관찰 메모', exact: true })).toHaveValue('');
  await expect(
    page.getByRole('group', { name: '시간 영역 광도곡선', exact: true }).locator('.transit-band'),
  ).toHaveCount(0);
  await choosePeak(page, 2);
  await expect(page.getByTestId('fold-zoom')).toHaveText('×1');
  expect(dataRequests).toEqual([]);
});

test('two-cycle drags are equivalent; keyboard handles adjust the interval and invalid widths keep it', async ({
  page,
}) => {
  await openObservation(page);
  await choosePeak(page);
  await page.getByRole('button', { name: '이 주기로 구간 고르기', exact: true }).click();
  await dragRatios(page, folded(page), 0.35, 0.39);
  const first = await page.getByTestId('phase-selection').innerText();
  const firstEpoch = await page.getByTestId('epoch-preview').innerText();
  const firstDuration = await page.getByTestId('duration-preview').innerText();
  await dragRatios(page, folded(page), 0.85, 0.89);
  expect(await page.getByTestId('phase-selection').innerText()).toBe(first);
  expect(await page.getByTestId('epoch-preview').innerText()).toBe(firstEpoch);
  expect(await page.getByTestId('duration-preview').innerText()).toBe(firstDuration);
  const startHandle = page.getByRole('slider', { name: '위상 시작 핸들', exact: true });
  const initial = Number(await startHandle.getAttribute('aria-valuenow'));
  await startHandle.focus();
  await page.keyboard.press('ArrowRight');
  expect(Number(await startHandle.getAttribute('aria-valuenow'))).toBeCloseTo(initial + 0.001, 9);
  const validSelection = await page.getByTestId('phase-selection').innerText();
  await dragRatios(page, folded(page), 0.1, 0.45);
  await expect(page.getByRole('alert')).toContainText('기존 선택을 유지했어요');
  await expect(page.getByTestId('phase-selection')).toHaveText(validSelection);
  await folded(page).focus();
  await page.keyboard.press('Equal');
  await page.keyboard.press('Equal');
  await page.keyboard.press('Equal');
  await expect(page.getByTestId('fold-zoom')).toHaveText('×8');
  await page.keyboard.press('0');
  await expect(page.getByTestId('fold-zoom')).toHaveText('×1');
});

test('drag previews update epoch, duration and time bands before release; pointer cancellation restores the committed selection', async ({
  page,
}) => {
  await openObservation(page);
  await choosePeak(page);
  await chooseCentralInterval(page);
  await chooseJudgment(page);
  const selection = page.getByTestId('phase-selection');
  const epoch = page.getByTestId('epoch-preview');
  const duration = page.getByTestId('duration-preview');
  const timeBands = page
    .getByRole('group', { name: '시간 영역 광도곡선', exact: true })
    .locator('.transit-band');
  const before = {
    selection: await selection.innerText(),
    epoch: await epoch.innerText(),
    duration: await duration.innerText(),
    bands: await timeBands.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('style')),
    ),
  };
  expect(before.bands.length).toBeGreaterThan(0);
  const chart = folded(page);
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error('접힌 그래프의 화면 영역이 없습니다.');
  const y = box.y + box.height * 0.6;
  await page.mouse.move(box.x + box.width * 0.6, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.66, y, { steps: 8 });

  // These checks happen while the pointer is still down: no selection has committed.
  await expect(selection).not.toHaveText(before.selection);
  await expect(epoch).not.toHaveText(before.epoch);
  await expect(duration).not.toHaveText(before.duration);
  expect(
    await timeBands.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('style')),
    ),
  ).not.toEqual(before.bands);
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeChecked();
  expect(await storedRecords(page)).toEqual([]);

  await chart.dispatchEvent('pointercancel', {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
  });
  await page.mouse.up();
  await expect(selection).toHaveText(before.selection);
  await expect(epoch).toHaveText(before.epoch);
  await expect(duration).toHaveText(before.duration);
  expect(
    await timeBands.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('style')),
    ),
  ).toEqual(before.bands);
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: '관찰 메모', exact: true })).toHaveValue(
    '반복되는 어두워짐을 확인함',
  );
});

test('a failed Worker keeps the last successful period, interval, judgment and memo; adjustment recovers', async ({
  page,
}) => {
  await installControlledWorker(page);
  await openObservation(page);
  await choosePeak(page);
  await chooseCentralInterval(page);
  await chooseJudgment(page);
  const period = page.getByLabel('주기 (일)', { exact: true });
  const originalPeriod = await period.inputValue();
  const originalInterval = await page.getByTestId('phase-selection').innerText();
  const next = String(
    Number(await period.inputValue()) +
      Number(await page.locator('#fine-period').getAttribute('step')),
  );
  await page.evaluate(() => {
    (
      window as unknown as { observationWorkerControl: { failNext: boolean } }
    ).observationWorkerControl.failNext = true;
  });
  await period.fill(next);
  await period.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    '마지막으로 성공한 주기·구간·판단을 유지했어요',
  );
  await expect(period).toHaveValue(originalPeriod);
  await expect(page.getByTestId('phase-selection')).toHaveText(originalInterval);
  await expect(page.getByRole('radio', { name: '행성 같음', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: '관찰 메모', exact: true })).toHaveValue(
    '반복되는 어두워짐을 확인함',
  );
  await period.fill(next);
  await period.press('Enter');
  await expect(
    page.getByRole('button', { name: '이 주기로 구간 고르기', exact: true }),
  ).toBeEnabled();
  await expect(period).toHaveValue(next);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a queued stale Worker response cannot overwrite a later peak selection', async ({ page }) => {
  await installControlledWorker(page);
  await openObservation(page);
  await choosePeak(page);
  await page.evaluate(() => {
    (
      window as unknown as { observationWorkerControl: { delayNext: boolean } }
    ).observationWorkerControl.delayNext = true;
  });
  await peak(page, 2).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { observationWorkerControl: { delayedReady: number } })
            .observationWorkerControl.delayedReady,
      ),
    )
    .toBe(1);
  await expect(folded(page)).toHaveAttribute('aria-disabled', 'true');
  await choosePeak(page, 3);
  const latestPeriod = await page.getByLabel('주기 (일)', { exact: true }).inputValue();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { observationWorkerControl: { deliveredLate: number } })
            .observationWorkerControl.deliveredLate,
      ),
    )
    .toBe(1);
  await expect(peak(page, 3)).toHaveAttribute('aria-pressed', 'true');
  await expect(peak(page, 2)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('주기 (일)', { exact: true })).toHaveValue(latestPeriod);
  await expect(folded(page)).toHaveAttribute('aria-disabled', 'false');
});

test('missing observation data shows a recoverable error without inventing an empty star', async ({
  page,
}) => {
  await page.route('**/observations/toi270.json', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Missing export' }),
  );
  await page.goto('/?mode=observations&target=toi270');
  await expect(page.getByRole('alert')).toContainText('로컬 관측 자료를 찾을 수 없습니다');
  await expect(page.getByRole('group', { name: '시간 영역 광도곡선', exact: true })).toHaveCount(0);
  await expect(page.locator('.observation-main')).not.toContainText('탐색 완료');
  await page.unroute('**/observations/toi270.json');
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(
    page.getByRole('group', { name: '시간 영역 광도곡선', exact: true }),
  ).toHaveAttribute('data-point-count', '44551');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('desktop charts fit at 1440 and 1024; the narrow viewport presents only the desktop gate', async ({
  page,
}) => {
  await openObservation(page);
  await choosePeak(page);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(folded(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-gate')).toBeVisible();
  await expect(page.locator('.mobile-gate')).toContainText('데스크톱에서이용해 주세요');
  await expect(folded(page)).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: '이 주기로 구간 고르기', exact: true }),
  ).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
