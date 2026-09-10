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
      <main className="page narrow">
        <section className="panel" role="alert">
          <h1>화면을 표시하지 못했습니다</h1>
          <p>
            자료를 다시 불러와 주세요. 저장하지 않은 입력은 다시 작성해야 할 수
            있습니다.
          </p>
          <button
            className="primary"
            onClick={() => this.setState({ failed: false })}
          >
            화면 다시 불러오기
          </button>
        </section>
      </main>
    ) : (
      this.props.children
    );
  }
}
