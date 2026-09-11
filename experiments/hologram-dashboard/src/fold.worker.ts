import { foldPoints } from './chart-math';

let times = new Float64Array();
let flux = new Float64Array();
let reference = 0;
let dataId = '';

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message.type === 'data') {
    times = message.times;
    flux = message.flux;
    reference = message.reference;
    dataId = message.dataId;
    return;
  }
  if (message.type !== 'fold' || message.dataId !== dataId) return;
  try {
    const result = foldPoints(times, flux, message.period, reference);
    const response = { type: 'folded', dataId, revision: message.revision,
      period: message.period, ...result };
    self.postMessage(response, { transfer: [result.phases.buffer, result.means.buffer, result.counts.buffer] });
  } catch (error) {
    self.postMessage({ type: 'error', dataId, revision: message.revision,
      message: error instanceof Error ? error.message : '위상 접기를 완료하지 못했습니다.' });
  }
};
