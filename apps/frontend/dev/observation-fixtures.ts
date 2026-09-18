import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OBSERVATION_TARGETS, CONVERSION_VERSION } from "./observation-data.ts";

export async function observationFixtureResponse(url: URL, directory: string) {
  const match =
    /^\/v1\/stars\/([^/]+)\/(analysis-context|curves|periodogram|candidate-peaks)$/.exec(
      url.pathname,
    );
  if (
    !match ||
    !OBSERVATION_TARGETS.some((target) => target.ticId === match[1])
  )
    return null;
  const [, ticId, resource] = match;
  try {
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    const entry = manifest.targets.find(
      (item: { ticId: string }) => item.ticId === ticId,
    );
    const bytes = await readFile(join(directory, `${ticId}.json`));
    if (
      manifest.conversion !== CONVERSION_VERSION ||
      !entry ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error("Invalid local observation export");
    const data = JSON.parse(bytes.toString("utf8"));
    const currentBundleId = data.context.bundle.bundleId as string;
    if (resource === "analysis-context")
      return { status: 200, body: data.context, currentBundleId };
    if (url.searchParams.get("bundleId") !== currentBundleId)
      return {
        status: 409,
        body: {
          code: "BUNDLE_CHANGED",
          currentBundleId,
          message: "관측 자료를 다시 불러와 주세요.",
        },
        currentBundleId,
      };
    if (
      url.searchParams.get("curveStep") !== "0" ||
      url.searchParams.has("removed")
    )
      return {
        status: 400,
        body: {
          code: "VALIDATION_FAILED",
          message: "이 관측 예제는 원본 단계만 제공합니다.",
        },
        currentBundleId,
      };
    if (resource === "periodogram" || resource === "candidate-peaks")
      return {
        status: 503,
        body: {
          code: "DEPENDENCY_UNAVAILABLE",
          message:
            "이 관측 곡선과 일치하는 주기도·봉우리 자료는 아직 연결하지 않았습니다.",
        },
        currentBundleId,
      };
    return { status: 200, body: data.curve, currentBundleId };
  } catch {
    return {
      status: 503,
      body: {
        code: "OBSERVATION_DATA_UNAVAILABLE",
        message:
          "로컬 관측 자료가 없거나 검증에 실패했습니다. data:prepare를 실행해 주세요.",
      },
    };
  }
}
