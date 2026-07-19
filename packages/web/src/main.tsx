import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { RoomPage } from "./pages/RoomPage";
import "./styles/app.css";

function JoinRedirect() {
  const [params] = useSearchParams();
  const join = params.get("join");
  const code = params.get("code");
  if (join && code) {
    // Landing still handles join form; prefill via session
    sessionStorage.setItem("cb:prefill", JSON.stringify({ roomId: join, code }));
  }
  return <Navigate to="/" replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="/join" element={<JoinRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
