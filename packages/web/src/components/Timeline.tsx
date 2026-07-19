import type { Branch, Participant } from "../lib/types";
import { IconBranch, IconLive } from "./icons";

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
  const scrubMax = Math.max(props.maxSeq, 1);

  return (
    <section
      className="timeline"
      aria-label="Private Time Travel"
      data-mode={live ? "live" : "history"}
    >
      <div className="timeline-header">
        <div className="timeline-title">
          <strong>Private Time Travel</strong>
          <span className={live ? "badge badge-live" : "badge badge-history"}>
            {live ? (
              <>
                <IconLive className="icon-sm" /> Live
              </>
            ) : (
              <>History · seq {value}</>
            )}
          </span>
        </div>
        <span className="timeline-status">
          {live
            ? "live — event history is encrypted end-to-end"
            : `seq ${value} / ${props.maxSeq} — event history is encrypted end-to-end`}
        </span>
      </div>

      <div className="timeline-scrub">
        <label htmlFor="scrub">Scrub timeline</label>
        <input
          id="scrub"
          type="range"
          min={0}
          max={scrubMax}
          value={value}
          disabled={props.maxSeq === 0}
          aria-valuemin={0}
          aria-valuemax={scrubMax}
          aria-valuenow={value}
          aria-valuetext={live ? "Live" : `Sequence ${value} of ${props.maxSeq}`}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= props.maxSeq) props.onScrub(null);
            else props.onScrub(v);
          }}
        />
      </div>

      <div className="timeline-controls">
        <div className="timeline-group" aria-label="Playback">
          <button
            type="button"
            className={live ? undefined : "primary"}
            onClick={() => props.onScrub(null)}
            disabled={live}
          >
            <IconLive className="icon-sm" />
            Jump to live
          </button>
        </div>

        <div className="timeline-group" aria-label="Filters">
          <label>
            Author
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
        </div>

        <div className="timeline-group" aria-label="Branches">
          <label>
            Branch
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
            <IconBranch className="icon-sm" />
            Fork from here
          </button>
        </div>
      </div>
    </section>
  );
}
