// v33.3 — reliable one-click downloads.
//
// The `download` attribute on <a> is IGNORED for cross-origin URLs (our
// videos live on Supabase storage), so clicks NAVIGATED to the mp4 instead
// of saving it — the single biggest "how do I download my purchase?"
// frustration. Fetch → blob → object-URL forces a real download with a
// clean filename. Falls back to opening the URL if the fetch fails (CORS,
// offline), so the user is never dead-ended.

export async function downloadVideo(url: string, filename: string): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

// Consistent, agent-friendly filenames: "123-main-st-square.mp4"
export function deliverableFilename(listingLabel: string, variant: string): string {
  const slug = (listingLabel || "vistalia-listing")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "vistalia-listing";
  return `${slug}-${variant}.mp4`;
}
