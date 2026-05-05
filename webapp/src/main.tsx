import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

function showFallback(message: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#0E0E10;color:#E8E2D6;font-family:system-ui,sans-serif">
      <div style="max-width:480px;width:100%;border:1px solid rgba(239,68,68,0.3);border-radius:16px;padding:32px;text-align:center">
        <div style="color:#f87171;font-size:18px;font-weight:600;margin-bottom:8px">Something went wrong</div>
        <pre style="font-size:12px;color:#9ca3af;text-align:left;background:#1a1a1c;border-radius:8px;padding:16px;overflow:auto;max-height:180px;margin-top:16px;white-space:pre-wrap">${message}</pre>
        <button onclick="window.location.reload()" style="margin-top:24px;height:40px;padding:0 24px;background:#C9A84C;color:#0E0E10;font-weight:600;border:none;border-radius:8px;cursor:pointer;font-size:14px">Reload</button>
      </div>
    </div>`;
}

window.addEventListener("error", (e) => {
  if (e.error) showFallback(e.error.message + "\n" + (e.error.stack || ""));
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason instanceof Error
    ? e.reason.message + "\n" + (e.reason.stack || "")
    : String(e.reason);
  showFallback(msg);
});

async function bootstrap() {
  try {
    const res = await fetch("/api/env", { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      new Function(text)();
    } else {
      window.ESTATEMOTION_API_ENV_UNAVAILABLE = true;
    }
  } catch {
    window.ESTATEMOTION_API_ENV_UNAVAILABLE = true;
  }

  const root = document.getElementById("root");
  if (!root) { showFallback("Root element not found"); return; }
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
