import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Load /api/env at runtime BEFORE React mounts. The endpoint returns
// JavaScript like `window.ESTATEMOTION_ENV = {...};` — we fetch and execute
// it so the env config (Supabase URL, mock flags, etc.) is available to the
// rest of the app via window.ESTATEMOTION_ENV.
//
// We can't use a <script src="/api/env"> tag in index.html because Vite tries
// to bundle script tags during build and a server endpoint is not a static
// file it can resolve.
async function bootstrap() {
  try {
    const res = await fetch("/api/env", { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      // Endpoint returns JS that sets window.ESTATEMOTION_ENV. Execute in
      // global scope. (Safe — we own this endpoint.)
      new Function(text)();
    } else {
      window.ESTATEMOTION_API_ENV_UNAVAILABLE = true;
    }
  } catch {
    window.ESTATEMOTION_API_ENV_UNAVAILABLE = true;
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
