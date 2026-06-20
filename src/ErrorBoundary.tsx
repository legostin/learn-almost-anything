import { Component, type ErrorInfo, type ReactNode } from "react";

// Generic render-error boundary. Without one, any throw inside the (large) editor
// tree unmounts the whole app to a blank white screen. This catches the throw,
// reports it via onError (e.g. to fall back to the classic editor), and renders
// a fallback instead.
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] caught", error, info.componentStack);
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) return this.props.fallback ?? null;
    return this.props.children;
  }
}
