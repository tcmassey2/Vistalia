// Sample listing for quick rendering tests without needing real uploads.
// All photos use public Unsplash URLs (CORS-safe, durable, no Supabase needed).

import type { ListingDetails, Photo } from "./types";

export const SAMPLE_LISTING: ListingDetails = {
  address: "9828 E Pinnacle Peak Rd",
  city: "Scottsdale, AZ",
  price: "$2,850,000",
  beds: "5",
  baths: "5.5",
  squareFeet: "5,640",
  hook: "A modern desert retreat built for evenings outside."
};

export const SAMPLE_PROJECT_TITLE = "Sample listing — Scottsdale";

const SAMPLE_PHOTOS_RAW: Array<[string, string, string]> = [
  // [filename, unsplashId, category-hint]
  ["exterior-front.jpg",      "1613490493576-7fde63acd811", "exterior"],
  ["entry-detail.jpg",        "1600585154340-be6161a56a0c", "exterior"],
  ["kitchen-island.jpg",      "1556909114-f6e7ad7d3136",   "kitchen"],
  ["living-room.jpg",         "1600210492486-724fe5c67fb0", "living"],
  ["primary-suite.jpg",       "1505693416388-ac5ce068fe85", "bedroom"],
  ["spa-bath.jpg",            "1552321554-5fefe8c9ef14",   "bathroom"],
  ["pool-patio.jpg",          "1582268611958-ebfd161ef9cf", "outdoor"],
  ["architectural-detail.jpg", "1556912173-3bb406ef7e77",  "detail"]
];

export function buildSamplePhotos(): Photo[] {
  const now = new Date().toISOString();
  return SAMPLE_PHOTOS_RAW.map(([fileName, id, _category], index) => {
    const url = `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1600&q=80`;
    return {
      id: `sample-${index + 1}`,
      fileName,
      publicUrl: url,
      durableUrl: url,
      storagePath: `samples/${fileName}`,
      bucket: "sample-fixtures",
      width: 1600,
      height: 1067,
      size: 0,
      order: index + 1,
      uploadedAt: now
    };
  });
}
