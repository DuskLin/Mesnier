import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 不把会话内容或凭据写入浏览器日志。
  }
  render() {
    if (this.state.failed) {
      return <main className="fatal-state"><h1>工作台暂时无法显示</h1><p>已保存的工作记录仍由应用保留。重新载入界面以恢复查看。</p><button className="button primary" onClick={() => location.reload()}>重新载入</button></main>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>,
);
