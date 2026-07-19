import type { Participant } from "../lib/types";

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
    <section aria-label="Participants">
      <h3>Participants ({approved.length}/8)</h3>
      <div className="stack">
        {approved.map((p) => (
          <div key={p.id} className="participant">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                {p.display_name}
                {p.id === props.selfId ? " (you)" : ""}
                {p.role === "host" ? " · host" : ""}
              </strong>
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
            <div className="fingerprint" title="Safety code — compare out-of-band">
              {p.fingerprint}
            </div>
          </div>
        ))}
      </div>

      {waiting.length > 0 ? (
        <>
          <h3 style={{ marginTop: "1rem" }}>Waiting room</h3>
          <div className="stack">
            {waiting.map((p) => (
              <div key={p.id} className="participant">
                <strong>{p.display_name}</strong>
                <div className="fingerprint">{p.fingerprint}</div>
                {props.isHost ? (
                  <div className="row">
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
        </>
      ) : null}
    </section>
  );
}
