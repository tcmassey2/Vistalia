import { useStore } from "../lib/store";

export default function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="toast fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg bg-surface-raised border border-edge text-sm text-ink shadow-2xl">
      {toast}
    </div>
  );
}
