import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";

const fps = 30;

export function getRenderDimensions(format = "vertical") {
  if (format === "square") return { width: 1080, height: 1080 };
  if (format === "wide" || format === "mls") return { width: 1920, height: 1080 };
  return { width: 1080, height: 1920 };
}

export function getRenderDurationFrames(manifest = {}) {
  const stylePack = stylePackForManifest(manifest);
  const sceneFrames = scenesFromManifest(manifest).reduce((sum, scene) => sum + secondsToFrames(scene.duration || 3), 0);
  return Math.max(300, sceneFrames + secondsToFrames(stylePack.outroDuration));
}

export function EstateMotionRender({ manifest = {}, format = "vertical" }) {
  const scenes = scenesFromManifest(manifest);
  const project = normalizeProject(manifest.project || {});
  const brandKit = normalizeBrandKit(manifest.brandKit || {}, project);
  const template = manifest.template || {};
  const stylePack = stylePackForManifest(manifest);
  const music = manifest.music || manifest.creative?.musicTrack || {};
  const dimensions = getRenderDimensions(format);
  const endCardFrames = secondsToFrames(stylePack.outroDuration);
  let cursor = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: stylePack.background, fontFamily: "Inter, Arial, sans-serif" }}>
      {music.url ? <Audio src={music.url} volume={stylePack.musicVolume} /> : null}
      {scenes.map((scene, index) => {
        const duration = secondsToFrames(scene.duration || stylePack.defaultSceneDuration);
        const from = cursor;
        cursor += duration;
        return (
          <Sequence key={`${scene.photoId || index}-${from}`} from={from} durationInFrames={duration + stylePack.overlapFrames}>
            {String(scene.type || "photo").toLowerCase() === "photo" ? (
              <RenderScene
                scene={scene}
                manifest={manifest}
                index={index}
                total={scenes.length}
                duration={duration}
                accentColor={template.accentColor || brandKit.accentColor || "#C7A76C"}
                dimensions={dimensions}
                stylePack={stylePack}
              />
            ) : (
              <RenderCardScene
                scene={scene}
                manifest={manifest}
                index={index}
                total={scenes.length}
                duration={duration}
                accentColor={template.accentColor || brandKit.accentColor || "#C7A76C"}
                stylePack={stylePack}
              />
            )}
          </Sequence>
        );
      })}
      <Sequence from={cursor} durationInFrames={endCardFrames}>
        <EndCard
          project={project}
          brandKit={brandKit}
          compliance={manifest.compliance || {}}
          accentColor={template.accentColor || brandKit.accentColor || "#C7A76C"}
          stylePack={stylePack}
        />
      </Sequence>
      {!music.url && stylePack.showMusicFallback ? <MusicFallbackBadge music={music} stylePack={stylePack} /> : null}
    </AbsoluteFill>
  );
}

function RenderCardScene({ scene, manifest, duration, accentColor, stylePack }) {
  const frame = useCurrentFrame();
  const project = normalizeProject(manifest.project || {});
  const brandKit = normalizeBrandKit(manifest.brandKit || {}, project);
  const progress = interpolate(frame, [0, duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = interpolate(frame, [0, 20, Math.max(30, duration - 18), duration], [0, 1, 1, .92], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 24], [36, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const facts = [project.price, project.beds ? `${project.beds} BD` : "", project.baths ? `${project.baths} BA` : "", project.squareFeet ? `${project.squareFeet} SQFT` : ""].filter(Boolean);
  return (
    <AbsoluteFill style={{ background: stylePack.background, color: "white", overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at 20% 18%, ${accentColor}55, transparent 34%), linear-gradient(145deg, ${stylePack.background}, #060606)` }} />
      <LightLeakOverlay progress={progress} stylePack={stylePack} />
      <BrandedFrame accentColor={accentColor} stylePack={stylePack} />
      <div style={{ position: "absolute", left: 72, right: 72, top: 210, opacity, transform: `translateY(${y}px)` }}>
        <p style={{ color: accentColor, fontSize: 25, fontWeight: 950, textTransform: "uppercase", margin: "0 0 18px" }}>{scene.cardLabel || stylePack.label}</p>
        <h1 style={{ fontFamily: stylePack.headlineFont, fontSize: scene.type === "stats" ? 74 : 88, lineHeight: .92, maxWidth: 920, margin: 0 }}>{scene.overlayText || project.address || "Featured listing"}</h1>
        {scene.overlaySubline ? <p style={{ fontSize: 34, lineHeight: 1.2, maxWidth: 820, margin: "28px 0 0", opacity: .86 }}>{scene.overlaySubline}</p> : null}
        {scene.type === "stats" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18, marginTop: 54, maxWidth: 760 }}>
            {facts.map((fact) => (
              <div key={fact} style={{ padding: "24px 26px", borderRadius: 18, background: "rgba(248,245,239,.94)", color: "#0D0D0D", fontSize: 32, fontWeight: 950 }}>{fact}</div>
            ))}
          </div>
        ) : null}
      </div>
      {scene.type === "stats" ? (
        <div style={{ position: "absolute", left: 72, right: 72, bottom: 132, padding: "24px 28px", borderRadius: 18, border: `1px solid ${accentColor}`, background: "rgba(13,13,13,.62)", color: "white" }}>
          <strong style={{ fontSize: 34 }}>{project.cta || brandKit.ctaText || "Schedule a private tour"}</strong>
          <span style={{ display: "block", marginTop: 10, fontSize: 24, opacity: .78 }}>{[brandKit.name, brandKit.brokerage].filter(Boolean).join(" / ")}</span>
        </div>
      ) : null}
      <ComplianceFooter compliance={manifest.compliance || {}} />
    </AbsoluteFill>
  );
}

function RenderScene({ scene, manifest, index, total, duration, accentColor, dimensions, stylePack }) {
  const frame = useCurrentFrame();
  const image = scene.durableUrl || scene.durable_url || scene.imageUrl || scene.uri || scene.photoUrl || "";
  const progress = interpolate(frame, [0, duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const entrance = interpolate(frame, [0, Math.min(18, duration * 0.18)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const exit = interpolate(frame, [Math.max(1, duration - 14), duration], [1, 0.94], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const transform = cameraTransform(scene.cameraMotion || scene.renderMotion || scene.motionStyle, progress, dimensions, scene.sceneType);
  const transitionStyle = transitionLayer(scene.directorTransition || scene.transition, entrance, exit, accentColor, stylePack);
  const project = normalizeProject(manifest.project || {});
  const brandKit = normalizeBrandKit(manifest.brandKit || {}, project);
  const showHero = index === 0;
  const sqft = project.sqft || project.squareFeet;
  const facts = [project.price, project.beds ? `${project.beds} BD` : "", project.baths ? `${project.baths} BA` : "", sqft ? `${sqft} SQFT` : ""].filter(Boolean).join("  /  ");
  const titleY = interpolate(frame, [8, 28], [34, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const titleOpacity = interpolate(frame, [6, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lowerThirdY = interpolate(frame, [22, 42], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lowerThirdOpacity = interpolate(frame, [18, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const priceScale = interpolate(frame, [26, 40], [0.96, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      {image ? (
        <Img
          src={image}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform,
            filter: stylePack.imageFilter
          }}
        />
      ) : (
        <AbsoluteFill style={{ background: "#1C1C1C" }} />
      )}
      <AbsoluteFill style={{ background: stylePack.gradient }} />
      <LightLeakOverlay progress={progress} stylePack={stylePack} />
      <BrandedFrame accentColor={accentColor} stylePack={stylePack} />
      {transitionStyle}
      <div style={{ position: "absolute", top: 54, left: 54, right: 54, color: "white", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ padding: "12px 18px", border: `1px solid ${accentColor}`, background: stylePack.badgeBackground, borderRadius: 999, fontSize: 22, fontWeight: 800, letterSpacing: 0, textTransform: "uppercase" }}>
          {stylePack.label}
        </span>
        <span style={{ fontSize: 20, opacity: .72 }}>{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
      </div>
      {showHero ? (
        <AddressIntro
          project={project}
          text={scene.overlayText || manifest.copy?.hook || project.title}
          accentColor={accentColor}
          stylePack={stylePack}
          opacity={titleOpacity}
          translateY={titleY}
        />
      ) : (
        <SceneTitle
          scene={scene}
          accentColor={accentColor}
          opacity={titleOpacity}
          translateY={titleY}
          stylePack={stylePack}
        />
      )}
      <LowerThird
        facts={facts}
        price={project.price}
        scene={scene}
        accentColor={accentColor}
        opacity={lowerThirdOpacity}
        translateY={lowerThirdY}
        priceScale={priceScale}
        stylePack={stylePack}
      />
      {showHero ? (
        <NeighborhoodTitleCard project={project} accentColor={accentColor} stylePack={stylePack} progress={progress} />
      ) : null}
      {stylePack.showMapPin && index === 1 ? (
        <MapPinCard project={project} accentColor={accentColor} stylePack={stylePack} progress={progress} />
      ) : null}
      {stylePack.showContactCta && index === total - 1 ? (
        <ContactCtaCard brandKit={brandKit} project={project} accentColor={accentColor} stylePack={stylePack} progress={progress} />
      ) : null}
      <PersistentBrandBadge brandKit={brandKit} accentColor={accentColor} />
      <ComplianceFooter compliance={manifest.compliance || {}} />
    </AbsoluteFill>
  );
}

function normalizeProject(project = {}) {
  const city = project.city || "";
  const neighborhood = project.neighborhood || city || "Local area";
  return {
    ...project,
    title: project.title || project.address || "Featured listing",
    address: project.address || project.title || "Featured listing",
    city: city || neighborhood,
    neighborhood,
    price: project.price || "",
    beds: project.beds || "",
    baths: project.baths || "",
    squareFeet: project.squareFeet || project.sqft || "",
    cta: project.cta || project.conversionGoal || "Schedule a private tour",
    brokerage: project.brokerage || ""
  };
}

function normalizeBrandKit(brandKit = {}, project = {}) {
  // Frontend ships AgentBranding ({ fullName, brokerage, phone, email,
  // headshotUrl }). The renderer historically used { name, brokerage, phone,
  // website, instagram, ctaText, headshotUrl }. We accept both shapes so
  // older callers continue to work.
  return {
    ...brandKit,
    name: brandKit.fullName || brandKit.name || project.agentName || "Your Local Agent",
    fullName: brandKit.fullName || brandKit.name || project.agentName || "Your Local Agent",
    brokerage: brandKit.brokerage || project.brokerage || "Real Estate Advisor",
    phone: brandKit.phone || project.phone || "",
    email: brandKit.email || project.email || "",
    website: brandKit.website || project.website || "",
    instagram: brandKit.instagram || project.instagram || "",
    headshotUrl: brandKit.headshotUrl || brandKit.headshot || "",
    ctaText: brandKit.ctaText || project.cta || "Schedule a private tour"
  };
}

function NeighborhoodTitleCard({ project, accentColor, stylePack, progress }) {
  if (!stylePack.showPremiumGraphics) return null;
  const opacity = interpolate(progress, [0.08, 0.22, 0.78, 0.92], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 64, top: 150, padding: "18px 22px", borderRadius: 16, background: stylePack.graphicCardBackground, border: `1px solid ${accentColor}`, color: stylePack.graphicTextColor, opacity }}>
      <span style={{ color: accentColor, fontSize: 18, fontWeight: 950, textTransform: "uppercase" }}>Neighborhood</span>
      <strong style={{ display: "block", fontSize: 30, marginTop: 6 }}>{[project.neighborhood, project.city].filter(Boolean).join(" / ") || "Local area"}</strong>
    </div>
  );
}

function MapPinCard({ project, accentColor, stylePack, progress }) {
  if (!stylePack.showPremiumGraphics) return null;
  const opacity = interpolate(progress, [0.12, 0.28, 0.78, 0.9], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(progress, [0.12, 0.28], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", right: 64, top: 150, width: 330, padding: 24, borderRadius: 20, background: stylePack.graphicCardBackground, color: stylePack.graphicTextColor, opacity, transform: `translateY(${y}px)`, border: `1px solid ${accentColor}` }}>
      <div style={{ width: 42, height: 42, borderRadius: 999, background: accentColor, color: "#0D0D0D", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 950 }}>⌖</div>
      <strong style={{ display: "block", marginTop: 16, fontSize: 27 }}>{project.city || "Property area"}</strong>
      <span style={{ display: "block", marginTop: 8, fontSize: 20, opacity: .82 }}>{project.address || project.neighborhood || "Listing location"}</span>
    </div>
  );
}

function ContactCtaCard({ brandKit, project, accentColor, stylePack, progress }) {
  if (!stylePack.showContactCta) return null;
  const opacity = interpolate(progress, [0.35, 0.55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", right: 64, bottom: 86, padding: "18px 22px", borderRadius: 18, background: stylePack.graphicCardBackground, color: stylePack.graphicTextColor, border: `1px solid ${accentColor}`, opacity }}>
      <strong style={{ display: "block", fontSize: 26 }}>{project.cta || brandKit.ctaText || "Schedule a private tour"}</strong>
      <span style={{ display: "block", fontSize: 19, marginTop: 8 }}>{[brandKit.phone, brandKit.website, brandKit.instagram].filter(Boolean).join(" / ") || brandKit.name}</span>
    </div>
  );
}

function LightLeakOverlay({ progress, stylePack }) {
  if (!stylePack.showLightLeak) return null;
  const x = interpolate(progress, [0, 1], [-24, 24]);
  const opacity = interpolate(progress, [0, .28, .72, 1], [0.05, 0.22, 0.16, 0.04]);
  return (
    <AbsoluteFill style={{ background: stylePack.lightLeakGradient, mixBlendMode: "screen", opacity, transform: `translateX(${x}px)` }} />
  );
}

function BrandedFrame({ accentColor, stylePack }) {
  if (!stylePack.showBrandedFrame) return null;
  return (
    <AbsoluteFill style={{ border: `14px solid ${stylePack.frameColor || accentColor}`, boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18)" }} />
  );
}

function MusicFallbackBadge({ music, stylePack }) {
  return (
    <div style={{ position: "absolute", right: 28, top: 28, padding: "10px 14px", borderRadius: 999, background: "rgba(13,13,13,.54)", color: "rgba(255,255,255,.72)", fontSize: 14 }}>
      {music.fallback || "No music file configured"}
    </div>
  );
}

function AddressIntro({ project, text, accentColor, stylePack, opacity, translateY }) {
  return (
    <div style={{ position: "absolute", left: 64, right: 64, bottom: 265, color: "white", opacity, transform: `translateY(${translateY}px)` }}>
      <p style={{ color: accentColor, fontSize: 24, fontWeight: 900, margin: "0 0 16px", textTransform: "uppercase" }}>{project.city || "Featured Listing"}</p>
      <h1 style={{ fontSize: stylePack.heroSize, lineHeight: .94, margin: 0, maxWidth: 900, fontFamily: stylePack.headlineFont }}>{text}</h1>
      <p style={{ fontSize: 30, fontWeight: 800, opacity: .86, margin: "22px 0 0" }}>{project.address || project.title}</p>
    </div>
  );
}

function SceneTitle({ scene, accentColor, opacity, translateY, stylePack }) {
  return (
    <div style={{ position: "absolute", left: 64, right: 64, bottom: 250, color: "white", opacity, transform: `translateY(${translateY}px)` }}>
      <p style={{ color: accentColor, fontSize: 21, fontWeight: 900, margin: "0 0 14px", textTransform: "uppercase" }}>{scene.sceneType || "Property Detail"}</p>
      <h2 style={{ fontSize: stylePack.sceneTitleSize, lineHeight: .98, margin: 0, maxWidth: 860, fontFamily: stylePack.headlineFont }}>{scene.overlayText || scene.sceneType || "Property highlight"}</h2>
    </div>
  );
}

function LowerThird({ facts, price, scene, accentColor, opacity, translateY, priceScale, stylePack }) {
  return (
    <div style={{ position: "absolute", left: 64, right: 64, bottom: 175, display: "flex", alignItems: "center", gap: 16, opacity, transform: `translateY(${translateY}px)`, color: "white" }}>
      {price ? (
        <div style={{ transform: `scale(${priceScale})`, transformOrigin: "left center", padding: "15px 20px", borderRadius: 12, background: stylePack.priceBackground, border: `1px solid ${accentColor}`, color: stylePack.priceColor, fontSize: 26, fontWeight: 950 }}>
          {price}
        </div>
      ) : null}
      {facts ? (
        <div style={{ padding: "15px 20px", borderRadius: 12, background: "rgba(13,13,13,.58)", backdropFilter: "blur(10px)", fontSize: 24, fontWeight: 850 }}>
          {facts}
        </div>
      ) : null}
      <div style={{ padding: "15px 18px", borderRadius: 12, background: "rgba(255,255,255,.12)", fontSize: 21, fontWeight: 800 }}>
        {scene.beatMarker || "Beat timed"}
      </div>
    </div>
  );
}

// Minimal persistent watermark — appears on every scene. Modeled after the
// Reel-e.ai bottom-left identity badge: tiny circular headshot + name +
// brokerage on a soft tinted plate. Subtle enough to not distract from the
// listing photo; consistent enough to drive brand recall across the reel.
function PersistentBrandBadge({ brandKit, accentColor }) {
  const name = brandKit?.fullName || brandKit?.name || "";
  const brokerage = brandKit?.brokerage || "";
  if (!name && !brokerage && !brandKit?.headshotUrl) return null;
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [4, 22], [0, 0.92], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const headshot = brandKit?.headshotUrl || "";
  return (
    <div
      style={{
        position: "absolute",
        left: 36,
        bottom: 36,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: headshot ? "8px 16px 8px 8px" : "10px 16px",
        borderRadius: 999,
        background: "rgba(13,13,13,0.62)",
        backdropFilter: "blur(8px)",
        border: `1px solid ${accentColor}55`,
        opacity,
        maxWidth: 460
      }}
    >
      {headshot ? (
        <div style={{ flexShrink: 0, width: 44, height: 44, borderRadius: "50%", overflow: "hidden", border: `1.5px solid ${accentColor}` }}>
          <Img src={headshot} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, color: "white", overflow: "hidden" }}>
        {name ? (
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0.2, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{name}</span>
        ) : null}
        {brokerage ? (
          <span style={{ fontSize: 14, fontWeight: 500, opacity: 0.78, marginTop: 2, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{brokerage}</span>
        ) : null}
      </div>
    </div>
  );
}

function EndCard({ project, brandKit, compliance, accentColor, stylePack }) {
  const cta = project.cta || brandKit.ctaText || "Schedule a private tour";
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 24], [36, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const headshot = brandKit.headshotUrl || "";
  const contactLine = [brandKit.phone, brandKit.email, brandKit.website, brandKit.instagram].filter(Boolean).join("  /  ");
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", backgroundColor: stylePack.endCardBackground, color: stylePack.endCardColor }}>
      <div style={{ width: 820, maxWidth: "82%", borderTop: `10px solid ${accentColor}`, background: stylePack.endCardPanel, color: stylePack.endCardPanelText, borderRadius: 18, padding: 58, boxShadow: "0 34px 90px rgba(13,13,13,.18)", opacity, transform: `translateY(${y}px)`, display: "flex", gap: 36, alignItems: "center" }}>
        {headshot ? (
          <div style={{ flexShrink: 0, width: 168, height: 168, borderRadius: "50%", overflow: "hidden", border: `4px solid ${accentColor}`, boxShadow: "0 18px 48px rgba(13,13,13,.22)" }}>
            <Img src={headshot} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: accentColor, fontWeight: 900, textTransform: "uppercase", fontSize: 22, letterSpacing: 1.2, margin: "0 0 14px" }}>{cta}</p>
          <h2 style={{ fontSize: 60, lineHeight: .95, margin: "0 0 14px", fontFamily: stylePack.headlineFont }}>{brandKit.name || "Your Local Agent"}</h2>
          <p style={{ fontSize: 28, color: stylePack.endCardMuted, margin: 0 }}>{brandKit.brokerage || project.brokerage || ""}</p>
          {contactLine ? <p style={{ fontSize: 24, margin: "22px 0 0", opacity: .9 }}>{contactLine}</p> : null}
        </div>
      </div>
      <ComplianceFooter compliance={compliance} dark={stylePack.endCardBackground !== "#0D0D0D"} />
    </AbsoluteFill>
  );
}

function ComplianceFooter({ compliance, dark = false }) {
  const copy = [compliance.listingCourtesyOf, compliance.brokerageDisclaimer, compliance.equalHousing ? "Equal Housing Opportunity" : "", compliance.mlsDisclaimer].filter(Boolean).join("  |  ");
  if (!copy) return null;
  return (
    <div style={{ position: "absolute", left: 34, right: 34, bottom: 24, color: dark ? "#444" : "rgba(255,255,255,.68)", fontSize: 16, textAlign: "center" }}>
      {copy}
    </div>
  );
}

function cameraTransform(style = "Push-in", progress, dimensions, sceneType = "") {
  const wide = dimensions.width > dimensions.height;
  const pan = wide ? 24 : 42;
  const normalized = String(style || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "push_in") {
    const scale = interpolate(progress, [0, 1], [1.015, 1.095]);
    const y = interpolate(progress, [0, 1], [8, -8]);
    return `scale(${scale}) translate3d(0, ${y}px, 0)`;
  }
  if (normalized === "pull_out") {
    const scale = interpolate(progress, [0, 1], [1.11, 1.02]);
    return `scale(${scale}) translate3d(0, 0, 0)`;
  }
  if (normalized === "lateral_pan") {
    const x = interpolate(progress, [0, 1], [-pan * 1.35, pan * 1.35]);
    return `scale(1.085) translate3d(${x}px, 0, 0)`;
  }
  if (normalized === "vertical_reveal") {
    const y = interpolate(progress, [0, 1], [38, -34]);
    return `scale(1.075) translate3d(0, ${y}px, 0)`;
  }
  if (normalized === "parallax_zoom") {
    const scale = interpolate(progress, [0, 1], [1.02, 1.135]);
    const x = interpolate(progress, [0, 1], [-10, 18]);
    const rotate = interpolate(progress, [0, 1], [-0.08, 0.08]);
    return `scale(${scale}) translate3d(${x}px, 0, 0) rotate(${rotate}deg)`;
  }
  if (normalized === "detail_sweep") {
    const x = interpolate(progress, [0, 1], [-34, 34]);
    const scale = interpolate(progress, [0, 1], [1.12, 1.055]);
    return `scale(${scale}) translate3d(${x}px, 0, 0)`;
  }
  // Unknown / missing motion — gentle default push.
  const scale = interpolate(progress, [0, 1], [1.01, 1.09]);
  return `scale(${scale}) translate3d(0, 0, 0)`;
}

function transitionLayer(transition = "", entrance, exit, accentColor, stylePack) {
  const normalized = String(transition || "").toLowerCase().replace(/[\s-]+/g, "_");
  const opacity = 1 - entrance;
  if (normalized === "whip_pan") {
    const x = interpolate(entrance, [0, 1], [-70, 100]);
    return <AbsoluteFill style={{ background: `linear-gradient(90deg, transparent, ${stylePack.transitionColor}, ${accentColor})`, opacity: opacity * .84, transform: `translateX(${x}%) skewX(-8deg)` }} />;
  }
  if (normalized === "match_cut") {
    return <AbsoluteFill style={{ background: "#FFFFFF", opacity: opacity * .24 }} />;
  }
  if (normalized === "light_leak") {
    const x = interpolate(entrance, [0, 1], [-40, 110]);
    return <AbsoluteFill style={{ background: `radial-gradient(circle at 35% 50%, ${accentColor}88, transparent 42%), linear-gradient(90deg, transparent, rgba(255,255,255,.32), transparent)`, mixBlendMode: "screen", opacity: opacity * .95, transform: `translateX(${x}%)` }} />;
  }
  if (normalized === "blur_wipe") {
    const x = interpolate(entrance, [0, 1], [0, -100]);
    return <AbsoluteFill style={{ background: `linear-gradient(90deg, ${accentColor}, ${stylePack.transitionColor})`, opacity: opacity * .88, filter: "blur(10px)", transform: `translateX(${x}%)` }} />;
  }
  if (transition.includes("slide")) {
    const x = interpolate(entrance, [0, 1], [0, 100]);
    return <AbsoluteFill style={{ background: stylePack.transitionColor, opacity, transform: `translateX(${x}%)` }} />;
  }
  if (transition.includes("wipe")) {
    const x = interpolate(entrance, [0, 1], [0, -100]);
    return <AbsoluteFill style={{ background: `linear-gradient(90deg, ${accentColor}, ${stylePack.transitionColor})`, opacity: opacity * .88, transform: `translateX(${x}%)` }} />;
  }
  return <AbsoluteFill style={{ background: stylePack.transitionColor, opacity: opacity * .72 }} />;
}

function stylePackForManifest(manifest = {}) {
  // Live frontend ships `selectedStyle` as the human-readable label — map
  // that to the four stylepacks the app currently exposes. The legacy
  // `stylePack` / `template.id` paths are kept as fallbacks so older saved
  // manifests still render.
  const label = String(
    manifest.selectedStyle || manifest.stylePack || manifest.template?.id || ""
  ).toLowerCase();
  if (label.includes("social") || label.includes("modern") || label.includes("viral") || label.includes("fast")) return stylePacks.viral;
  if (label.includes("mls") || label.includes("clean")) return stylePacks.mlsClean;
  if (label.includes("investor")) return stylePacks.investor;
  return stylePacks.luxury;
}

const stylePacks = {
  luxury: {
    label: "EstateMotion Luxury",
    background: "#0D0D0D",
    transitionColor: "#0D0D0D",
    gradient: "linear-gradient(180deg, rgba(0,0,0,.12), rgba(0,0,0,.04) 38%, rgba(0,0,0,.84))",
    badgeBackground: "rgba(13,13,13,.56)",
    imageFilter: "contrast(1.04) saturate(1.02)",
    priceBackground: "rgba(248,245,239,.94)",
    priceColor: "#0D0D0D",
    endCardBackground: "#F8F5EF",
    endCardPanel: "white",
    endCardColor: "#0D0D0D",
    endCardPanelText: "#0D0D0D",
    endCardMuted: "#454545",
    headlineFont: "Georgia, 'Times New Roman', serif",
    heroSize: 78,
    sceneTitleSize: 58,
    defaultSceneDuration: 2.45,
    outroDuration: 3.5,
    overlapFrames: 10,
    showFeatureCards: true
    ,
    showPremiumGraphics: true,
    showLightLeak: true,
    showBrandedFrame: true,
    showMapPin: true,
    showContactCta: true,
    showMusicFallback: true,
    musicVolume: 0.42,
    graphicCardBackground: "rgba(13,13,13,.58)",
    graphicTextColor: "#FFFFFF",
    lightLeakGradient: "radial-gradient(circle at 18% 28%, rgba(199,167,108,.38), transparent 34%), radial-gradient(circle at 82% 12%, rgba(255,255,255,.16), transparent 30%)"
  },
  viral: {
    label: "EstateMotion Viral",
    background: "#070707",
    transitionColor: "#070707",
    gradient: "linear-gradient(180deg, rgba(0,0,0,.18), rgba(0,0,0,.08) 34%, rgba(0,0,0,.88))",
    badgeBackground: "rgba(13,13,13,.72)",
    imageFilter: "contrast(1.09) saturate(1.08)",
    priceBackground: "rgba(199,167,108,.96)",
    priceColor: "#0D0D0D",
    endCardBackground: "#0D0D0D",
    endCardPanel: "#F8F5EF",
    endCardColor: "#F8F5EF",
    endCardPanelText: "#0D0D0D",
    endCardMuted: "#57524b",
    headlineFont: "Inter, Arial, sans-serif",
    heroSize: 74,
    sceneTitleSize: 62,
    defaultSceneDuration: 1.35,
    outroDuration: 2.7,
    overlapFrames: 6,
    showFeatureCards: false,
    showPremiumGraphics: true,
    showLightLeak: true,
    showBrandedFrame: true,
    showMapPin: true,
    showContactCta: true,
    showMusicFallback: true,
    musicVolume: 0.5,
    graphicCardBackground: "rgba(13,13,13,.68)",
    graphicTextColor: "#FFFFFF",
    lightLeakGradient: "radial-gradient(circle at 20% 20%, rgba(227,187,115,.28), transparent 30%)"
  },
  mlsClean: {
    label: "MLS Clean",
    background: "#F8F5EF",
    transitionColor: "#F8F5EF",
    gradient: "linear-gradient(180deg, rgba(0,0,0,.04), rgba(0,0,0,.02) 44%, rgba(0,0,0,.62))",
    badgeBackground: "rgba(248,245,239,.84)",
    imageFilter: "contrast(1.0) saturate(0.98)",
    priceBackground: "rgba(248,245,239,.96)",
    priceColor: "#0D0D0D",
    endCardBackground: "#F8F5EF",
    endCardPanel: "white",
    endCardColor: "#0D0D0D",
    endCardPanelText: "#0D0D0D",
    endCardMuted: "#555",
    headlineFont: "Inter, Arial, sans-serif",
    heroSize: 60,
    sceneTitleSize: 46,
    defaultSceneDuration: 2.4,
    outroDuration: 3.2,
    overlapFrames: 4,
    showFeatureCards: false,
    showPremiumGraphics: false,
    showLightLeak: false,
    showBrandedFrame: false,
    showMapPin: false,
    showContactCta: false,
    showMusicFallback: false,
    musicVolume: 0.18,
    graphicCardBackground: "rgba(248,245,239,.92)",
    graphicTextColor: "#0D0D0D",
    lightLeakGradient: "transparent"
  },
  investor: {
    label: "Investor Reel",
    background: "#11150F",
    transitionColor: "#11150F",
    gradient: "linear-gradient(180deg, rgba(0,0,0,.16), rgba(0,0,0,.05) 40%, rgba(0,0,0,.82))",
    badgeBackground: "rgba(17,21,15,.68)",
    imageFilter: "contrast(1.06) saturate(0.98)",
    priceBackground: "rgba(228,232,215,.94)",
    priceColor: "#11150F",
    endCardBackground: "#11150F",
    endCardPanel: "#F8F5EF",
    endCardColor: "#F8F5EF",
    endCardPanelText: "#11150F",
    endCardMuted: "#4d5548",
    headlineFont: "Inter, Arial, sans-serif",
    heroSize: 66,
    sceneTitleSize: 50,
    defaultSceneDuration: 1.85,
    outroDuration: 3,
    overlapFrames: 5,
    showFeatureCards: true,
    showPremiumGraphics: true,
    showLightLeak: true,
    showBrandedFrame: true,
    showMapPin: true,
    showContactCta: true,
    showMusicFallback: true,
    musicVolume: 0.44,
    graphicCardBackground: "rgba(17,21,15,.7)",
    graphicTextColor: "#FFFFFF",
    lightLeakGradient: "radial-gradient(circle at 85% 20%, rgba(199,167,108,.24), transparent 32%)"
  },
};

function scenesFromManifest(manifest = {}) {
  const photos = manifest.orderedPhotos || [];
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  return (manifest.scenes || []).map((scene) => {
    const photo = photosById.get(scene.photoId) || {};
    return {
      ...scene,
      imageUrl: photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || photo.imageUrl || photo.uri || scene.durableUrl || scene.durable_url || scene.publicUrl || scene.public_url || scene.imageUrl || scene.uri || "",
      duration: Number(scene.duration || 3)
    };
  });
}

function secondsToFrames(seconds) {
  return Math.max(45, Math.round(Number(seconds || 3) * fps));
}
