import type { ConnStatus } from "../lib/types";

export function TopBar(props: {
  title?: string;
  status?: ConnStatus;
  subtitle?: string;
}) {
  const dot =
    props.status === "open"
      ? "ok"
      : props.status === "connecting"
        ? "warn"
        : props.status === "error"
          ? "err"
          : "";
  return (
    <header className="topbar">
      <div className="row">
        <h1>Cipherboard</h1>
        {props.title ? <span className="muted">/ {props.title}</span> : null}
      </div>
      <div className="row muted">
        {props.status ? (
          <span>
            <span className={`status-dot ${dot}`} aria-hidden />
            {props.status === "open"
              ? "connected"
              : props.status === "connecting"
                ? "connecting"
                : props.status === "closed"
                  ? "disconnected"
                  : "error"}
          </span>
        ) : null}
        {props.subtitle ? <span>{props.subtitle}</span> : null}
      </div>
    </header>
  );
}
