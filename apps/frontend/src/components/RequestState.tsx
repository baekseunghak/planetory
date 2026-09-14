import { ApiError } from "../api/client";
export function LoadingState() {
  return (
    <p role="status" className="status">
      정보를 불러오고 있습니다…
    </p>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const title =
    apiError?.status === 403
      ? "접근 권한이 없습니다"
      : apiError?.status === 404
        ? "자료를 찾을 수 없거나 볼 수 없습니다"
        : "정보를 불러오지 못했습니다";
  return (
    <section className="status" role="alert">
      <h1>{title}</h1>
      <p>{error.message}</p>
      {apiError?.outcomeUnknown && (
        <p>
          처리 결과를 확인하지 못했습니다. 입력을 유지하고 저장 여부를 먼저
          확인해 주세요.
        </p>
      )}
      {!!apiError?.fieldErrors.length && (
        <ul>
          {apiError.fieldErrors.map((item, i) => (
            <li key={i}>{item.reason}</li>
          ))}
        </ul>
      )}
      {apiError?.requestId && <small>문의 번호: {apiError.requestId}</small>}
      {retry && <button onClick={retry}>다시 불러오기</button>}
    </section>
  );
}
