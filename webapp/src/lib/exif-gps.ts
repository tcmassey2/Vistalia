// Vistalia — EXIF GPS extraction (v62.96, the "EXIF rescue").
//
// Photographer-direct uploads often still carry GPS coordinates — MLS
// processing strips EXIF, but the dump-area audience uploads BEFORE or
// outside the MLS. When a photos-only project has no address, the
// coordinates in the first photo that has them let us SUGGEST the listing
// address (reverse-geocoded, confirmed by the agent — never assumed:
// the GPS could be the photographer's office).
//
// Scope-tight JPEG APP1/TIFF parser: finds the EXIF APP1 segment, walks
// IFD0 for the GPS IFD pointer (tag 0x8825), reads GPSLatitude/Ref and
// GPSLongitude/Ref as the rational triplets the spec defines. Returns
// null on anything unexpected — no throws, no dependencies, reads only
// the first 256KB of the file.

export interface GpsFix {
  lat: number;
  lng: number;
}

export async function extractGpsFromJpeg(file: File): Promise<GpsFix | null> {
  try {
    if (!/image\/jpe?g/i.test(file.type)) return null;
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 12 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

    // Walk JPEG segments for APP1/"Exif\0\0".
    let offset = 2;
    let tiffStart = -1;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda) break; // start of scan — no EXIF past here
      const size = view.getUint16(offset + 2);
      if (marker === 0xe1 && offset + 10 <= view.byteLength &&
          view.getUint32(offset + 4) === 0x45786966 /* "Exif" */ &&
          view.getUint16(offset + 8) === 0x0000) {
        tiffStart = offset + 10;
        break;
      }
      offset += 2 + size;
    }
    if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return null;

    const endian = view.getUint16(tiffStart);
    const little = endian === 0x4949; // "II"
    if (!little && endian !== 0x4d4d) return null;
    const u16 = (o: number) => view.getUint16(o, little);
    const u32 = (o: number) => view.getUint32(o, little);
    if (u16(tiffStart + 2) !== 0x002a) return null;

    const ifd0 = tiffStart + u32(tiffStart + 4);
    if (ifd0 + 2 > view.byteLength) return null;

    // Find the GPS IFD pointer in IFD0.
    let gpsIfd = -1;
    const entries0 = u16(ifd0);
    for (let i = 0; i < entries0; i++) {
      const e = ifd0 + 2 + i * 12;
      if (e + 12 > view.byteLength) return null;
      if (u16(e) === 0x8825) { gpsIfd = tiffStart + u32(e + 8); break; }
    }
    if (gpsIfd < 0 || gpsIfd + 2 > view.byteLength) return null;

    // Read the four GPS tags we need.
    let latRef = "", lngRef = "";
    let latOff = -1, lngOff = -1;
    const gpsEntries = u16(gpsIfd);
    for (let i = 0; i < gpsEntries; i++) {
      const e = gpsIfd + 2 + i * 12;
      if (e + 12 > view.byteLength) return null;
      const tag = u16(e);
      if (tag === 0x0001) latRef = String.fromCharCode(view.getUint8(e + 8));       // GPSLatitudeRef (inline ASCII)
      else if (tag === 0x0002) latOff = tiffStart + u32(e + 8);                     // GPSLatitude (3 rationals)
      else if (tag === 0x0003) lngRef = String.fromCharCode(view.getUint8(e + 8));  // GPSLongitudeRef
      else if (tag === 0x0004) lngOff = tiffStart + u32(e + 8);                     // GPSLongitude
    }
    if (latOff < 0 || lngOff < 0) return null;

    const rational = (o: number) => {
      const num = u32(o);
      const den = u32(o + 4);
      return den ? num / den : 0;
    };
    const dms = (o: number) => {
      if (o + 24 > view.byteLength) return NaN;
      return rational(o) + rational(o + 8) / 60 + rational(o + 16) / 3600;
    };
    let lat = dms(latOff);
    let lng = dms(lngOff);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (/s/i.test(latRef)) lat = -lat;
    if (/w/i.test(lngRef)) lng = -lng;
    // Sanity: (0,0) is the classic stripped/garbage fix; reject bounds too.
    if ((lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

// Scan a batch for the first usable fix — a few files is plenty; if the
// shoot has GPS at all, every frame has it.
export async function firstGpsInFiles(files: File[], maxScan = 5): Promise<GpsFix | null> {
  for (const f of files.slice(0, maxScan)) {
    const fix = await extractGpsFromJpeg(f);
    if (fix) return fix;
  }
  return null;
}
