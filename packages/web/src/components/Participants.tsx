import type { Participant } from "../lib/types";
import { IconUsers } from "./icons";

export function Participants(props: {
  participants: Participant[];
  selfId: string;
  isHost: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const waiting = props.participants.filter((p) => p.status === "waiting");
  const approved = props.participants.filter((p) => p.status === "approved");

  return (
    <section className="participants" aria-label="Participants">
      {waiting.length > 0 ? (
        <div className="stack-sm" aria-label="Waiting room">
          <div className="waiting-list-header">
            <h4>Waiting for approval</h4>
            <span className="badge badge-attention" aria-live="polite">
              {waiting.length} waiting
            </span>
          </div>
          <div className="stack-sm">
            {waiting.map((p) => (
              <div key={p.id} className="participant waiting-item">
                <div className="participant-head">
                  <div>
                    <div className="participant-name">{p.display_name}</div>
                    <div className="participant-meta">Needs host approval</div>
                  </div>
                </div>
                <div
                  className="fingerprint"
                  title="Safety code — compare out-of-band"
                >
                  {p.fingerprint}
                </div>
                {props.isHost ? (
                  <div className="participant-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => props.onApprove(p.id)}
                    >
                      Approve
                    </button>
                    <button type="button" onClick={() => props.onReject(p.id)}>
                      Reject
                    </button>
                  </div>
                ) : (
                  <span className="muted">Awaiting host approval</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="stack-sm">
        <div className="participants-heading">
          <h3>
            <IconUsers className="icon-sm" /> In room ({approved.length}/8)
          </h3>
        </div>
        {approved.length === 0 ? (
          <div className="empty-state">No approved participants yet.</div>
        ) : (
          <div className="stack-sm">
            {approved.map((p) => (
              <div key={p.id} className="participant">
                <div className="participant-head">
                  <div>
                    <div className="participant-name">
                      {p.display_name}
                      {p.id === props.selfId ? " (you)" : ""}
                    </div>
                    <div className="participant-meta">
                      {p.role === "host" ? "Host" : "Participant"}
                    </div>
                  </div>
                  {props.isHost && p.id !== props.selfId && p.role !== "host" ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => props.onRemove(p.id)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <div
                  className="fingerprint"
                  title="Safety code — compare out-of-band"
                >
                  {p.fingerprint}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
