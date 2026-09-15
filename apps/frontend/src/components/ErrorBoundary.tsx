import { Component, type ReactNode } from "react";
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="page" role="alert">
        <h1>화면을 표시하지 못했습니다</h1>
        <p>페이지를 새로고침한 뒤 다시 시도해 주세요.</p>
        <button onClick={() => window.location.reload()}>새로고침</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
