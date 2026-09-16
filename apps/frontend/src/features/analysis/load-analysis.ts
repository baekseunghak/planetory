import { ApiError, type createApiClient } from "../../api/client";
import { curvePath, decodeAnalysisContext, decodeCurve } from "./analysis-data";

type Request = ReturnType<typeof createApiClient>["request"];
class BundleChanged extends Error {}

// Read one consistent pair. A second race is left to manual retry.
export async function loadAnalysis(
  request: Request,
  ticId: string,
  signal: AbortSignal,
  onBundleChanged: () => void,
  previousBundleId?: string,
) {
  let changed = false;
  const announce = () => {
    if (!changed) onBundleChanged();
    changed = true;
  };
  async function read(path: string, expectedBundleId?: string) {
    let bundleId: string | null = null;
    let status = 0;
    let body: unknown;
    try {
      body = await request<unknown>(path, {
        signal,
        onResponse: (response) => {
          bundleId = response.headers.get("X-Current-Bundle")?.trim() || null;
          status = response.status;
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      // Access and service failures retain their original meaning.
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "BUNDLE_CHANGED"
      )
        throw new BundleChanged();
      if (
        status >= 200 &&
        status < 300 &&
        expectedBundleId &&
        bundleId &&
        bundleId !== expectedBundleId
      )
        throw new BundleChanged();
      throw error;
    }
    signal.throwIfAborted();
    if (expectedBundleId && bundleId && bundleId !== expectedBundleId)
      throw new BundleChanged();
    return { body, bundleId };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await read(
        `/v1/stars/${encodeURIComponent(ticId)}/analysis-context`,
      );
      const context = decodeAnalysisContext(response.body, ticId);
      if (
        response.bundleId &&
        response.bundleId !== context.curveContext.bundleId
      )
        throw new BundleChanged();
      if (
        previousBundleId &&
        previousBundleId !== context.curveContext.bundleId
      )
        announce();
      const result = await read(
        curvePath(context),
        context.curveContext.bundleId,
      );
      const curve = decodeCurve(result.body, context);
      signal.throwIfAborted();
      return { context, curve, bundleChanged: changed };
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof BundleChanged)) throw error;
      announce();
      if (attempt === 1)
        throw new Error(
          "데이터 판이 계속 바뀌어 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.",
        );
    }
  }
  throw new Error("분석 자료를 불러오지 못했습니다.");
}
