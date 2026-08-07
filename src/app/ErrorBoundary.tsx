import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * App-wide error boundary so a fault in one page shows a recoverable message
 * instead of unmounting the whole tree to a blank screen. Also surfaces the
 * error text, which is invaluable when debugging a minified production build.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <div className="error-screen__title">页面出错了</div>
          <pre className="error-screen__msg">{this.state.error.message}</pre>
          <button className="error-screen__btn" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
