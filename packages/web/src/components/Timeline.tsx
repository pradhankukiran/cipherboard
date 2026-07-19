import type { Branch, Participant } from "../lib/types";

export function Timeline(props: {
  maxSeq: number;
  scrubSeq: number | null;
  onScrub: (seq: number | null) => void;
  authorFilter: string | null;
  onAuthorFilter: (id: string | null) => void;
  participants: Participant[];
  branches: Branch[];
  activeBranchId: string;
  onBranch: (id: string) => void;
  onFork: (name: string, forkSeq: number) => void;
}) {
  const live = props.scrubSeq === null;
  const value = props.scrubSeq ?? props.maxSeq;

  return (
    <section className="timeline" aria-label="Private Time Travel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Private Time Travel</strong>
        <span className="muted">
          {live ? "live" : `seq ${value} / ${props.maxSeq}`} — event history is
          encrypted end-to-end
        </span>
      </div>
      <label className="muted" htmlFor="scrub">
        Scrub timeline
      </label>
      <input
        id="scrub"
        type="range"
        min={0}
        max={Math.max(props.maxSeq, 1)}
        value={value}
        disabled={props.maxSeq === 0}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (v >= props.maxSeq) props.onScrub(null);
          else props.onScrub(v);
        }}
      />
      <div className="row">
        <button type="button" onClick={() => props.onScrub(null)} disabled={live}>
          Jump to live
        </button>
        <label>
          Author{" "}
          <select
            value={props.authorFilter ?? ""}
            onChange={(e) =>
              props.onAuthorFilter(e.target.value ? e.target.value : null)
            }
          >
            <option value="">All</option>
            {props.participants
              .filter((p) => p.status === "approved")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Branch{" "}
          <select
            value={props.activeBranchId}
            onChange={(e) => props.onBranch(e.target.value)}
          >
            {props.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={props.maxSeq === 0}
          onClick={() => {
            const name = window.prompt("Branch name", `fork-${value}`);
            if (name) props.onFork(name, value);
          }}
        >
          Fork from here
        </button>
      </div>
    </section>
  );
}
