import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { IconChevronLeft, IconChevronRight, IconShield } from "../components/icons";
import {
  loadProtectedLesson,
  type LoadProtectedLessonResult,
  type ProtectedLesson,
} from "../lib/protectedLesson";

type Status = "loading" | "ready" | "error";

function paintLesson(
  canvas: HTMLCanvasElement,
  lesson: ProtectedLesson,
  throughStep: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 400;
  const cssH = canvas.clientHeight || 300;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.strokeStyle = "#c8c8c8";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);

  const steps = lesson.steps.filter((s) => s.index <= throughStep);
  for (const step of steps) {
    for (const stroke of step.strokes) {
      if (stroke.points.length === 0) continue;
      ctx.save();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(stroke.points[0]!.x, stroke.points[0]!.y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i]!.x, stroke.points[i]!.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

export function ProtectedLessonPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LoadProtectedLessonResult | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    setResult(null);
    setStepIdx(0);
    try {
      const loaded = await loadProtectedLesson();
      setResult(loaded);
      setStepIdx(0);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const step = result.lesson.steps[stepIdx];
    const through = step?.index ?? 0;
    paintLesson(canvasRef.current, result.lesson, through);
  }, [result, stepIdx]);

  useEffect(() => {
    if (!result) return;
    const onResize = () => {
      if (!canvasRef.current) return;
      const step = result.lesson.steps[stepIdx];
      paintLesson(canvasRef.current, result.lesson, step?.index ?? 0);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [result, stepIdx]);

  const steps = result?.lesson.steps ?? [];
  const maxStep = Math.max(steps.length - 1, 0);
  const current = steps[stepIdx];

  return (
    <div className="app-shell">
      <TopBar title="Protected Lesson Replay" />
      <main className="protected-lesson" id="main">
        <header className="protected-lesson-header">
          <p className="eyebrow">Demo showcase</p>
          <h2>Protected Lesson Replay</h2>
          <p className="lede">
            A short instructor lesson sealed on the server, unwrapped in the
            browser, and decrypted through a Rust/Wasm seam that only holds
            opaque WebCrypto handles — never raw AES key bytes in linear memory.
          </p>
          <p className="protected-lesson-nav">
            <Link to="/">Back to rooms</Link>
          </p>
        </header>

        {status === "loading" ? (
          <div className="protected-lesson-state" role="status" aria-live="polite">
            Sealing and unwrapping the demo lesson…
          </div>
        ) : null}

        {status === "error" ? (
          <div className="error-box" role="alert">
            <p>{error ?? "Failed to load protected lesson."}</p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => void load()}>
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {status === "ready" && result ? (
          <>
            <section
              className="protected-lesson-audit"
              aria-label="Security audit facts"
              data-testid="protected-lesson-audit"
            >
              <h3>
                <IconShield className="icon-sm" /> Boundary audit
              </h3>
              <dl>
                <div>
                  <dt>RSA private extractable</dt>
                  <dd data-testid="audit-rsa-extractable">
                    {String(result.audit.rsaPrivateExtractable)}
                  </dd>
                </div>
                <div>
                  <dt>AES content key extractable</dt>
                  <dd data-testid="audit-aes-extractable">
                    {String(result.audit.aesExtractable)}
                  </dd>
                </div>
                <div>
                  <dt>AES usages</dt>
                  <dd data-testid="audit-aes-usages">
                    {result.audit.aesUsages.join(", ") || "(none)"}
                  </dd>
                </div>
                <div>
                  <dt>Boundary mode</dt>
                  <dd data-testid="audit-boundary-mode">
                    {result.audit.boundaryMode}
                  </dd>
                </div>
                <div>
                  <dt>Key bytes in Wasm linear memory</dt>
                  <dd data-testid="audit-key-bytes">
                    {String(result.audit.keyBytesEnterWasmLinearMemory)}
                  </dd>
                </div>
                <div>
                  <dt>Plaintext return</dt>
                  <dd data-testid="audit-plaintext">
                    {result.audit.plaintextReturnedAs}
                  </dd>
                </div>
              </dl>
              <p className="protected-lesson-audit-note">
                AES key bytes never enter Wasm linear memory. Plaintext is returned
                as a JS ArrayBuffer from SubtleCrypto; it does exist briefly in JS
                for decode and paint.
              </p>
            </section>

            <section
              className="protected-lesson-stage"
              aria-label="Lesson replay"
            >
              <div className="protected-lesson-meta">
                <h3>{result.lesson.title}</h3>
                <p className="muted">
                  Step {stepIdx + 1} of {steps.length}
                  {current ? ` — ${current.label}` : ""}
                </p>
                {current?.note ? <p className="protected-lesson-note">{current.note}</p> : null}
              </div>

              <div className="protected-lesson-canvas-wrap">
                <canvas
                  ref={canvasRef}
                  className="protected-lesson-canvas"
                  role="img"
                  aria-label={`Lesson board at step ${stepIdx + 1}`}
                  data-testid="protected-lesson-canvas"
                />
              </div>

              <div className="protected-lesson-controls">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Previous step"
                  disabled={stepIdx <= 0}
                  onClick={() => setStepIdx((s) => Math.max(0, s - 1))}
                >
                  <IconChevronLeft className="icon-sm" />
                </button>
                <label className="protected-lesson-scrub" htmlFor="lesson-scrub">
                  <span className="sr-only">Lesson step</span>
                  <input
                    id="lesson-scrub"
                    data-testid="protected-lesson-scrub"
                    type="range"
                    min={0}
                    max={maxStep}
                    value={stepIdx}
                    onChange={(e) => setStepIdx(Number(e.target.value))}
                    aria-valuemin={0}
                    aria-valuemax={maxStep}
                    aria-valuenow={stepIdx}
                    aria-valuetext={
                      current
                        ? `Step ${stepIdx + 1}: ${current.label}`
                        : `Step ${stepIdx + 1}`
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Next step"
                  disabled={stepIdx >= maxStep}
                  onClick={() => setStepIdx((s) => Math.min(maxStep, s + 1))}
                >
                  <IconChevronRight className="icon-sm" />
                </button>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
