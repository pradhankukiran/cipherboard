import type { ConnStatus } from "../lib/types";

function statusLabel(status: ConnStatus): string {
  if (status === "open") return "connected";
  if (status === "connecting") return "connecting";
  if (status === "closed") return "disconnected";
  return "error";
}

function statusDot(status: ConnStatus): string {
  if (status === "open") return "ok";
  if (status === "connecting") return "warn";
  if (status === "error") return "err";
  return "";
}

export function TopBar(props: {
  title?: string;
  status?: ConnStatus;
  subtitle?: string;
}) {
  return (
    <header className="topbar" role="banner">
      <div className="topbar-brand">
        <h1>Cipherboard</h1>
        {props.title ? (
          <span className="topbar-title" title={props.title}>
            / {props.title}
          </span>
        ) : null}
      </div>
      <div className="topbar-meta">
        {props.status ? (
          <span className="topbar-status" aria-live="polite">
            <span
              className={`status-dot ${statusDot(props.status)}`}
              aria-hidden
            />
            {statusLabel(props.status)}
          </span>
        ) : null}
        {props.subtitle ? <span>{props.subtitle}</span> : null}
      </div>
    </header>
  );
}
