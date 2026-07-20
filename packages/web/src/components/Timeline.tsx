import type { Branch, Participant } from "../lib/types";
import { canStepNext, canStepPrev, stepScrub } from "../lib/scrubStep";
import {
  IconBranch,
  IconChevronLeft,
  IconChevronRight,
  IconLive,
} from "./icons";

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
  const hasHistory = props.maxSeq > 0;
  const readout = live
    ? "Live"
    : `Event ${value} of ${props.maxSeq}`;
  const valueText = live
    ? "Live"
    : `Sequence ${value} of ${props.maxSeq}`;

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
              <>History</>
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
        <div className="timeline-scrub-header">
          <label htmlFor="scrub">Scrub timeline</label>
          <output
            className="timeline-readout"
            htmlFor="scrub"
            aria-live="polite"
          >
            {readout}
          </output>
        </div>

        <div className="timeline-scrub-row">
          <button
            type="button"
            className="icon-btn timeline-step"
            aria-label="Previous event"
            disabled={!canStepPrev(props.scrubSeq, props.maxSeq)}
            onClick={() =>
              props.onScrub(stepScrub(props.scrubSeq, props.maxSeq, "prev"))
            }
          >
            <IconChevronLeft className="icon-sm" />
          </button>

          <div className="timeline-range-wrap">
            <input
              id="scrub"
              type="range"
              min={0}
              max={scrubMax}
              value={value}
              disabled={!hasHistory}
              aria-valuemin={0}
              aria-valuemax={scrubMax}
              aria-valuenow={value}
              aria-valuetext={valueText}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= props.maxSeq) props.onScrub(null);
                else props.onScrub(v);
              }}
            />
            <div className="timeline-endpoints" aria-hidden="true">
              <span>Beginning</span>
              <span>Live</span>
            </div>
          </div>

          <button
            type="button"
            className="icon-btn timeline-step"
            aria-label="Next event"
            disabled={!canStepNext(props.scrubSeq, props.maxSeq)}
            onClick={() =>
              props.onScrub(stepScrub(props.scrubSeq, props.maxSeq, "next"))
            }
          >
            <IconChevronRight className="icon-sm" />
          </button>
        </div>
      </div>

      <div className="timeline-controls">
        {!live && (
          <div className="timeline-group" aria-label="Playback">
            <button
              type="button"
              className="primary"
              onClick={() => props.onScrub(null)}
            >
              <IconLive className="icon-sm" />
              Jump to live
            </button>
          </div>
        )}

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
            disabled={!hasHistory}
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
