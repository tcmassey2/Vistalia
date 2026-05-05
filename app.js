const storageKey = "estatemotion.local.mvp.v2";
const legacyStorageKey = "estatemotion.local.mvp.v1";

const featureFlags = readFeatureFlags();

const templates = [
  {
    id: "modern-luxury",
    name: "Modern Luxury",
    description: "Slow cinematic movement, editorial titles, black/ivory/champagne finish.",
    fontStyle: "Elegant Sans",
    textPlacement: "bottom",
    motionSpeed: "slow",
    transitionStyle: "soft fade",
    ctaWording: "Schedule your private showing",
    accentColor: "#C7A76C",
    visualCue: "Editorial black frame"
  },
  {
    id: "desert-luxury",
    name: "Scottsdale Desert Luxury",
    description: "Warm desert neutrals, resort pacing, and upscale local-market language.",
    fontStyle: "Editorial Sans",
    textPlacement: "split",
    motionSpeed: "medium",
    transitionStyle: "gold wipe",
    ctaWording: "Tour this Arizona listing",
    accentColor: "#B88746",
    visualCue: "Desert resort reveal"
  },
  {
    id: "viral-fast-cut",
    name: "Viral Fast Cut",
    description: "Punchy social-native rhythm, curiosity hooks, and fast scene changes.",
    fontStyle: "Bold Sans",
    textPlacement: "top",
    motionSpeed: "fast",
    transitionStyle: "snap cut",
    ctaWording: "DM for the full tour",
    accentColor: "#E3BB73",
    visualCue: "High-retention Reel"
  },
  {
    id: "open-house",
    name: "Open House Promo",
    description: "Event-forward story format with date-ready CTA blocks.",
    fontStyle: "Bold Sans",
    textPlacement: "center",
    motionSpeed: "fast",
    transitionStyle: "whip pan",
    ctaWording: "Visit the open house",
    accentColor: "#111111",
    visualCue: "Event invitation"
  },
  {
    id: "mls-clean",
    name: "MLS Clean",
    description: "Compliance-safe, minimal, and property-first for broad distribution.",
    fontStyle: "Clean Sans",
    textPlacement: "bottom",
    motionSpeed: "medium",
    transitionStyle: "clean dissolve",
    ctaWording: "Request listing details",
    accentColor: "#6C717A",
    visualCue: "MLS-safe clarity"
  },
  {
    id: "agent-brand-builder",
    name: "Agent Brand Builder",
    description: "Agent-forward storytelling with stronger end-card authority and CTA.",
    fontStyle: "Luxury Sans",
    textPlacement: "center",
    motionSpeed: "medium",
    transitionStyle: "brand reveal",
    ctaWording: "Follow for more local homes",
    accentColor: "#2D7D78",
    visualCue: "Personal brand lift"
  },
  {
    id: "investor-wholesale",
    name: "Investor/Wholesale Deal",
    description: "Direct, numbers-aware pacing for deal flow and buyer-demand angles.",
    fontStyle: "Direct Sans",
    textPlacement: "left rail",
    motionSpeed: "medium",
    transitionStyle: "clean cut",
    ctaWording: "Ask for details",
    accentColor: "#4C7A45",
    visualCue: "Deal-focused proof"
  },
  {
    id: "neighborhood-authority",
    name: "Neighborhood Authority",
    description: "Local expert content for city, neighborhood, and market-positioning reels.",
    fontStyle: "Editorial Sans",
    textPlacement: "map card",
    motionSpeed: "medium",
    transitionStyle: "location reveal",
    ctaWording: "Ask me about this area",
    accentColor: "#3E6E78",
    visualCue: "Local expert map"
  },
  {
    id: "personal-brand-agent",
    name: "Personal Brand Agent",
    description: "Agent-forward reels for credibility, trust, and repeatable authority content.",
    fontStyle: "Luxury Sans",
    textPlacement: "agent lower third",
    motionSpeed: "medium",
    transitionStyle: "brand reveal",
    ctaWording: "Follow for local real estate strategy",
    accentColor: "#C7A76C",
    visualCue: "Agent authority"
  }
];

const demoPhotos = [
  {
    id: "demo-1",
    uri: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80",
    fileName: "exterior-front.jpg",
    category: "Exterior",
    order: 1
  },
  {
    id: "demo-2",
    uri: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=80",
    fileName: "living-room.jpg",
    category: "Living room",
    order: 2
  },
  {
    id: "demo-3",
    uri: "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1200&q=80",
    fileName: "kitchen.jpg",
    category: "Kitchen",
    order: 3
  },
  {
    id: "demo-4",
    uri: "https://images.unsplash.com/photo-1615873968403-89e068629265?auto=format&fit=crop&w=1200&q=80",
    fileName: "primary-bedroom.jpg",
    category: "Primary bedroom",
    order: 4
  }
];

const sampleProjects = [
  {
    id: "sample-scottsdale",
    title: "Modern Desert Retreat",
    location: "Scottsdale, AZ",
    type: "Just Listed",
    thumbnail: demoPhotos[0].uri
  },
  {
    id: "sample-arcadia",
    title: "Arcadia Family Remodel",
    location: "Phoenix, AZ",
    type: "Open House",
    thumbnail: demoPhotos[1].uri
  },
  {
    id: "sample-tempe",
    title: "Tempe Townhouse Launch",
    location: "Tempe, AZ",
    type: "Coming Soon",
    thumbnail: demoPhotos[2].uri
  }
];

const betaSampleListing = {
  title: "Scottsdale Beta Sample Listing",
  address: "9828 E Pinnacle Peak Road",
  price: "$2,850,000",
  beds: "5",
  baths: "5.5",
  squareFeet: "5,640",
  neighborhood: "Silverleaf",
  city: "Scottsdale",
  listingType: "Just Listed",
  hookText: "Inside a Scottsdale luxury listing built for desert living",
  caption: "A polished sample listing reel using real property-style photos, factual captions, and editable scene sequencing.",
  cta: "Schedule a private tour",
  hookPreset: "Luxury",
  captionTone: "Luxury",
  reelTheme: "scottsdale-desert-luxury",
  textAnimation: "Luxury minimal",
  musicMood: "Luxury",
  outroVariation: "Headshot + CTA",
  thumbnailPreset: "Inside This Home",
  reelVariations: [],
  brandingVisible: true,
  authenticityMode: true,
  localAgentMode: true,
  introText: "",
  outroText: "",
  reelPlanEdits: null,
  photos: [
    ["beta-1", "https://images.unsplash.com/photo-1600607687644-c7171b42498f?auto=format&fit=crop&w=1200&q=80", "scottsdale-exterior-hero.jpg", "Exterior hero"],
    ["beta-2", "https://images.unsplash.com/photo-1600566753376-12c8ab7fb75b?auto=format&fit=crop&w=1200&q=80", "scottsdale-entry.jpg", "Entry / front door"],
    ["beta-3", "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1200&q=80", "scottsdale-kitchen-island.jpg", "Kitchen"],
    ["beta-4", "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1200&q=80", "scottsdale-living-room.jpg", "Living room"],
    ["beta-5", "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1200&q=80", "scottsdale-primary-bedroom.jpg", "Primary bedroom"],
    ["beta-6", "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1200&q=80", "scottsdale-bathroom.jpg", "Bathroom"],
    ["beta-7", "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=80", "scottsdale-backyard-pool.jpg", "Backyard / pool"],
    ["beta-8", "https://images.unsplash.com/photo-1615873968403-89e068629265?auto=format&fit=crop&w=1200&q=80", "scottsdale-detail-shot.jpg", "Detail shots"]
  ].map(([id, uri, fileName, category], index) => ({
    id,
    uri,
    publicUrl: uri,
    public_url: uri,
    durableUrl: uri,
    durable_url: uri,
    fileName,
    category,
    pipelineCategory: sceneToPipelineCategorySafe(category),
    confidence: 92,
    classificationSource: "sample fixture",
    tags: [],
    visibleFeatures: [],
    description: `Sample ${category.toLowerCase()} scene for beta testing.`,
    order: index + 1,
    size: 0,
    width: 1200,
    height: 800,
    bucket: "sample-fixtures",
    storagePath: ""
  }))
};

const sceneTypes = [
  "Exterior hero",
  "Entry / front door",
  "Kitchen",
  "Living room",
  "Dining",
  "Primary bedroom",
  "Bathroom",
  "Backyard / pool",
  "Neighborhood / amenities",
  "Detail shots"
];

const featuredPropertyFlow = [
  "Exterior hero",
  "Entry / front door",
  "Interior reveal",
  "Kitchen",
  "Living room",
  "Dining",
  "Primary bedroom",
  "Bathroom",
  "Backyard / pool",
  "Neighborhood / amenities",
  "CTA close",
  "Detail shots"
];

const hookPresets = {
  "Just Listed": "Just listed in {city}: a home buyers will want to see fast",
  "Open House": "Open house this week: step inside this {city} listing",
  Luxury: "Inside a luxury {city} home with standout design",
  "Under $X": "Inside this {city} home under {price}",
  "Investment Opportunity": "Investment opportunity in {city} with strong buyer appeal",
  "Scottsdale Luxury": "Inside this Scottsdale luxury listing built for desert resort living",
  "Phoenix Starter Home": "Inside this Phoenix starter home buyers can actually picture themselves in",
  "Arcadia Family Home": "Arcadia family living with the spaces buyers replay"
};

const captionTonePresets = {
  Luxury: "Elevated, polished, and cinematic with a premium real estate voice.",
  Friendly: "Warm, approachable, and easy for everyday buyers to understand.",
  Viral: "Short, curiosity-led, and social-native with fast pattern interrupts.",
  Investor: "Numbers-aware, opportunity-focused, and direct.",
  "First-time buyer": "Clear, encouraging, and focused on value and livability.",
  "Local agent mode": "Neighborhood-specific, agent-led, and grounded in local market language."
};

const ctaPresets = ["DM for price", "Book a showing", "Schedule private tour", "Tour this home", "Ask for details", "Schedule showing"];
const conversionCtas = ["DM for price", "Schedule showing", "Investor details", "Join waitlist", "Seller consultation", "Book valuation call"];
const contentModes = [
  { id: "listing-reel", name: "Listing Reel", bestFor: "Social attention", template: "modern-luxury", cta: "Schedule showing" },
  { id: "open-house-promo", name: "Open House Promo", bestFor: "Event traffic", template: "open-house", cta: "Book a showing" },
  { id: "agent-brand", name: "Agent Personal Brand Reel", bestFor: "Authority", template: "personal-brand-agent", cta: "Follow for local real estate strategy" },
  { id: "neighborhood-spotlight", name: "Neighborhood Spotlight", bestFor: "Local trust", template: "neighborhood-authority", cta: "Ask me about this area" },
  { id: "price-drop", name: "Price Drop / Under Contract", bestFor: "Urgency", template: "viral-fast-cut", cta: "DM for price" },
  { id: "seller-lead-magnet", name: "Seller Lead Magnet", bestFor: "Listing appointments", template: "personal-brand-agent", cta: "Seller consultation" },
  { id: "investor-breakdown", name: "Investor Deal Breakdown", bestFor: "Investor leads", template: "investor-wholesale", cta: "Investor details" },
  { id: "wholesale-opportunity", name: "Wholesale Opportunity", bestFor: "Buyer list", template: "investor-wholesale", cta: "Join waitlist" }
];
const sellerTools = [
  "Seller presentation export mode",
  "Before/after marketing comparison",
  "Your home could look like this online",
  "Listing presentation reel preview",
  "Branded PDF/video combo ready later"
];
const investorDealFields = ["ARV", "Rehab estimate", "Cap rate", "Cash flow", "Deal structure", "Assignment fee"];
const contentGoalRecommendations = {
  "listing-reel": { template: "modern-luxury", label: "Recommended for listing promo" },
  "open-house-promo": { template: "open-house", label: "Recommended for open house traffic" },
  "agent-brand": { template: "personal-brand-agent", label: "Recommended for personal brand" },
  "neighborhood-spotlight": { template: "neighborhood-authority", label: "Recommended for neighborhood authority" },
  "price-drop": { template: "viral-fast-cut", label: "Recommended for urgency" },
  "seller-lead-magnet": { template: "personal-brand-agent", label: "Recommended for seller leads" },
  "investor-breakdown": { template: "investor-wholesale", label: "Recommended for investor deals" },
  "wholesale-opportunity": { template: "investor-wholesale", label: "Recommended for wholesale buyers" }
};

const sceneIntelligence = {
  "Exterior hero": {
    keywords: ["exterior", "front", "curb", "street", "hero", "facade", "elevation"],
    suggestedMotion: "Depth zoom",
    overlay: "Curb appeal opener"
  },
  "Entry / front door": {
    keywords: ["entry", "foyer", "door", "front-door", "hall", "arrival", "porch"],
    suggestedMotion: "Push-in",
    overlay: "Step inside"
  },
  Kitchen: {
    keywords: ["kitchen", "island", "pantry", "cabinet", "range", "counter"],
    suggestedMotion: "Slow pan",
    overlay: "Kitchen spotlight"
  },
  "Living room": {
    keywords: ["living", "great", "family", "lounge", "fireplace"],
    suggestedMotion: "Pull-out",
    overlay: "Main living reveal"
  },
  Dining: {
    keywords: ["dining", "breakfast", "nook", "table"],
    suggestedMotion: "Slow pan",
    overlay: "Dining moment"
  },
  "Primary bedroom": {
    keywords: ["primary", "master", "bedroom", "suite"],
    suggestedMotion: "Push-in",
    overlay: "Primary suite"
  },
  Bathroom: {
    keywords: ["bath", "vanity", "shower", "tub", "powder"],
    suggestedMotion: "Vertical social framing",
    overlay: "Bath detail"
  },
  "Backyard / pool": {
    keywords: ["yard", "pool", "patio", "garden", "terrace", "balcony", "outdoor", "spa"],
    suggestedMotion: "Orbit simulation",
    overlay: "Outdoor lifestyle"
  },
  "Neighborhood / amenities": {
    keywords: ["neighborhood", "amenity", "club", "park", "community", "view", "mountain", "golf"],
    suggestedMotion: "Slow pan",
    overlay: "Neighborhood context"
  },
  "Detail shots": {
    keywords: ["detail", "fixture", "finish", "tile", "hardware", "lighting"],
    suggestedMotion: "Depth zoom",
    overlay: "Design detail"
  }
};

const motionSystems = {
  Luxury: { defaultMotion: "Depth zoom", tempo: "slow cinematic", baseDuration: 2.75, transition: "light leak", beatEvery: 2 },
  Viral: { defaultMotion: "Push-in", tempo: "punchy cuts", baseDuration: 1.18, transition: "whip pan", beatEvery: 1 },
  "Open House": { defaultMotion: "Pull-out", tempo: "energetic invite", baseDuration: 1.55, transition: "whip reveal", beatEvery: 1 },
  Investor: { defaultMotion: "Slow pan", tempo: "strategic proof", baseDuration: 1.85, transition: "match cut", beatEvery: 2 },
  MLS: { defaultMotion: "Push-in", tempo: "clean property tour", baseDuration: 2.35, transition: "crossfade", beatEvery: 2 },
  "First-time buyer": { defaultMotion: "Push-in", tempo: "approachable tour", baseDuration: 1.75, transition: "friendly slide", beatEvery: 2 }
};

const reelThemes = [
  {
    id: "luxury-modern",
    name: "Luxury Modern",
    accent: "#C7A76C",
    background: "#101113",
    description: "Black, white, gold, editorial spacing."
  },
  {
    id: "scottsdale-desert-luxury",
    name: "Scottsdale Desert Luxury",
    accent: "#B88746",
    background: "#2B2118",
    description: "Warm desert neutrals with resort energy."
  },
  {
    id: "open-house-fast-cut",
    name: "Open House Fast Cut",
    accent: "#111111",
    background: "#F8F6F1",
    description: "Bold event-forward cuts and urgent CTA."
  },
  {
    id: "first-time-buyer-friendly",
    name: "First-Time Buyer Friendly",
    accent: "#2D7D78",
    background: "#F7FAF9",
    description: "Clear, helpful, approachable overlays."
  },
  {
    id: "investor-cash-flow",
    name: "Investor / Cash Flow",
    accent: "#4C7A45",
    background: "#111711",
    description: "Direct, numbers-aware, opportunity-led."
  }
];

const textAnimationStyles = ["Fade", "Slide up", "Bold cut", "Luxury minimal"];
const musicMoods = ["Luxury", "Modern", "Energetic", "Corporate"];
const outroVariations = ["Headshot + CTA", "Brokerage logo only", "Social follow CTA"];
const thumbnailPresets = ["Just Listed", "Inside This Home", "Phoenix Property Tour"];
const reelVariationPresets = {
  Premium: {
    reelTheme: "luxury-modern",
    textAnimation: "Luxury minimal",
    musicMood: "Luxury",
    outroVariation: "Headshot + CTA",
    thumbnailPreset: "Inside This Home",
    captionTone: "Luxury"
  },
  "Social Viral": {
    reelTheme: "open-house-fast-cut",
    textAnimation: "Bold cut",
    musicMood: "Energetic",
    outroVariation: "Social follow CTA",
    thumbnailPreset: "Just Listed",
    captionTone: "Friendly"
  },
  Professional: {
    reelTheme: "scottsdale-desert-luxury",
    textAnimation: "Fade",
    musicMood: "Corporate",
    outroVariation: "Brokerage logo only",
    thumbnailPreset: "Phoenix Property Tour",
    captionTone: "Investor"
  }
};

const showcaseProjects = [
  {
    id: "showcase-phoenix-starter",
    title: "Phoenix Starter Home",
    location: "Phoenix, AZ",
    type: "Just Listed",
    price: "$485,000",
    themeLabel: "First-Time Buyer Friendly",
    thumbnail: "https://images.unsplash.com/photo-1605276374104-dee2a0ed3cd6?auto=format&fit=crop&w=1200&q=80",
    project: {
      title: "Phoenix Starter Home",
      address: "1842 E Palm Lane",
      price: "$485,000",
      beds: "3",
      baths: "2",
      squareFeet: "1,720",
      neighborhood: "Coronado",
      city: "Phoenix",
      listingType: "Just Listed",
      hookText: "Inside this Phoenix starter home under $500K",
      caption: "A bright central Phoenix home with practical updates, inviting living spaces, and a neighborhood buyers already love.",
      cta: "DM for price",
      hookPreset: "Under $X",
      captionTone: "First-time buyer",
      reelTheme: "first-time-buyer-friendly",
      textAnimation: "Slide up",
      musicMood: "Modern",
      outroVariation: "Headshot + CTA",
      thumbnailPreset: "Just Listed",
      reelVariations: [],
      brandingVisible: true,
      authenticityMode: true,
      localAgentMode: true,
      photos: [
        { id: "phx-1", uri: "https://images.unsplash.com/photo-1605276374104-dee2a0ed3cd6?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-exterior-hero.jpg", category: "Exterior hero", order: 1 },
        { id: "phx-2", uri: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-entry-transition.jpg", category: "Entry transition", order: 2 },
        { id: "phx-3", uri: "https://images.unsplash.com/photo-1556912172-45b7abe8b7e1?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-kitchen.jpg", category: "Kitchen", order: 3 },
        { id: "phx-4", uri: "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-living-room.jpg", category: "Living room", order: 4 },
        { id: "phx-5", uri: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-primary-bedroom.jpg", category: "Primary bedroom", order: 5 },
        { id: "phx-6", uri: "https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-bathroom.jpg", category: "Bathroom", order: 6 },
        { id: "phx-7", uri: "https://images.unsplash.com/photo-1597047084897-51e81819a499?auto=format&fit=crop&w=1200&q=80", fileName: "phoenix-backyard-patio.jpg", category: "Backyard", order: 7 }
      ]
    },
    selectedTemplateId: "agent-brand-builder",
    whyThisWorks: {
      Hook: "The price-led hook makes the home feel attainable and scroll-stopping for entry buyers.",
      "Scene pacing": "The reel opens with curb appeal, moves quickly into livable spaces, then closes on the backyard lifestyle beat.",
      CTA: "A simple DM CTA keeps the next step low-friction for buyers who are still early.",
      Branding: "The agent appears as a helpful guide, not a hard sell, which fits first-time buyer psychology."
    }
  },
  {
    id: "showcase-arcadia-family",
    title: "Arcadia Family Home",
    location: "Arcadia, Phoenix, AZ",
    type: "Open House",
    price: "$1,095,000",
    themeLabel: "Luxury Modern",
    thumbnail: "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1200&q=80",
    project: {
      title: "Arcadia Family Home",
      address: "4325 E Campbell Avenue",
      price: "$1,095,000",
      beds: "4",
      baths: "3",
      squareFeet: "2,860",
      neighborhood: "Arcadia",
      city: "Arcadia",
      listingType: "Open House",
      hookText: "Open house this week in Arcadia: family living with designer updates",
      caption: "A polished Arcadia home with generous gathering spaces, a standout kitchen, and the kind of backyard that sells the lifestyle instantly.",
      cta: "Tour this home",
      hookPreset: "Open House",
      captionTone: "Friendly",
      reelTheme: "luxury-modern",
      textAnimation: "Fade",
      musicMood: "Corporate",
      outroVariation: "Headshot + CTA",
      thumbnailPreset: "Phoenix Property Tour",
      reelVariations: [],
      brandingVisible: true,
      authenticityMode: true,
      localAgentMode: true,
      photos: [
        { id: "arc-1", uri: "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-exterior-hero.jpg", category: "Exterior hero", order: 1 },
        { id: "arc-2", uri: "https://images.unsplash.com/photo-1616137466211-f939a420be84?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-entry.jpg", category: "Entry transition", order: 2 },
        { id: "arc-3", uri: "https://images.unsplash.com/photo-1600489000022-c2086d79f9d4?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-kitchen-island.jpg", category: "Kitchen", order: 3 },
        { id: "arc-4", uri: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-living-room.jpg", category: "Living room", order: 4 },
        { id: "arc-5", uri: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-primary-suite.jpg", category: "Primary bedroom", order: 5 },
        { id: "arc-6", uri: "https://images.unsplash.com/photo-1600566752229-250ed79470f8?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-bathroom.jpg", category: "Bathroom", order: 6 },
        { id: "arc-7", uri: "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-backyard.jpg", category: "Backyard", order: 7 },
        { id: "arc-8", uri: "https://images.unsplash.com/photo-1600566753151-384129cf4e3e?auto=format&fit=crop&w=1200&q=80", fileName: "arcadia-detail-shot.jpg", category: "Detail shots", order: 8 }
      ]
    },
    selectedTemplateId: "open-house",
    whyThisWorks: {
      Hook: "The open-house hook gives agents an immediate reason to post and buyers a reason to act this week.",
      "Scene pacing": "The sequence alternates big family spaces with warm details so it feels premium without dragging.",
      CTA: "The tour CTA matches event intent and makes the reel useful for Stories, Reels, and follow-up texts.",
      Branding: "The end card reinforces the agent and brokerage while keeping the property as the hero."
    }
  },
  {
    id: "showcase-scottsdale-luxury",
    title: "Scottsdale Luxury Listing",
    location: "Scottsdale, AZ",
    type: "Coming Soon",
    price: "$2,850,000",
    themeLabel: "Scottsdale Desert Luxury",
    thumbnail: "https://images.unsplash.com/photo-1600607687644-c7171b42498f?auto=format&fit=crop&w=1200&q=80",
    project: {
      title: "Scottsdale Luxury Listing",
      address: "9828 E Pinnacle Peak Road",
      price: "$2,850,000",
      beds: "5",
      baths: "5.5",
      squareFeet: "5,640",
      neighborhood: "Silverleaf",
      city: "Scottsdale",
      listingType: "Coming Soon",
      hookText: "Inside a Scottsdale luxury home built for desert resort living",
      caption: "A cinematic Scottsdale listing with warm architecture, resort-style outdoor living, and refined spaces designed for memorable showings.",
      cta: "Schedule showing",
      hookPreset: "Luxury",
      captionTone: "Luxury",
      reelTheme: "scottsdale-desert-luxury",
      textAnimation: "Luxury minimal",
      musicMood: "Luxury",
      outroVariation: "Brokerage logo only",
      thumbnailPreset: "Inside This Home",
      reelVariations: [],
      brandingVisible: true,
      authenticityMode: true,
      localAgentMode: true,
      photos: [
        { id: "sdl-1", uri: "https://images.unsplash.com/photo-1600607687644-c7171b42498f?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-exterior-hero.jpg", category: "Exterior hero", order: 1 },
        { id: "sdl-2", uri: "https://images.unsplash.com/photo-1600566753376-12c8ab7fb75b?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-entry-transition.jpg", category: "Entry transition", order: 2 },
        { id: "sdl-3", uri: "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-kitchen.jpg", category: "Kitchen", order: 3 },
        { id: "sdl-4", uri: "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-living-room.jpg", category: "Living room", order: 4 },
        { id: "sdl-5", uri: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-primary-bedroom.jpg", category: "Primary bedroom", order: 5 },
        { id: "sdl-6", uri: "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-bathroom.jpg", category: "Bathroom", order: 6 },
        { id: "sdl-7", uri: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-backyard-pool.jpg", category: "Backyard", order: 7 },
        { id: "sdl-8", uri: "https://images.unsplash.com/photo-1615873968403-89e068629265?auto=format&fit=crop&w=1200&q=80", fileName: "scottsdale-detail-shot.jpg", category: "Detail shots", order: 8 }
      ]
    },
    selectedTemplateId: "desert-luxury",
    whyThisWorks: {
      Hook: "The luxury hook sells the feeling first, which is what high-end buyers and listing agents expect.",
      "Scene pacing": "Longer hero beats, warm transitions, and outdoor lifestyle scenes make the reel feel cinematic.",
      CTA: "The showing CTA protects exclusivity and feels appropriate for a premium listing.",
      Branding: "Brokerage-forward outro keeps the presentation polished for seller meetings and partner demos."
    }
  }
].map((showcase) => ({
  ...showcase,
  project: {
    ...showcase.project,
    reelVariations: Object.entries(reelVariationPresets).map(([name, settings]) => ({
      name,
      hook: `${name}: ${showcase.project.hookText}`,
      settings
    }))
  }
}));

const defaultState = {
  hasOnboarded: false,
  screen: "dashboard",
  authStatus: featureFlags.MOCK_SUPABASE ? "mock" : "checking",
  authEmail: "",
  authPassword: "",
  authMode: "sign-in",
  authReturnScreen: "dashboard",
  pendingExportAfterAuth: false,
  selectedTemplateId: "desert-luxury",
  selectedShowcaseId: "showcase-scottsdale-luxury",
  selectedScene: 0,
  exportResult: null,
  renderQueue: [],
  renderJobStatus: null,
  loading: "",
  error: "",
  toasts: [],
  leads: [],
  betaFeedback: [],
  analyticsEvents: [],
  betaFeedbackForm: {
    rating: "5",
    usableEnough: "yes",
    feedback: ""
  },
  earlyAccessForm: {
    name: "",
    email: "",
    brokerage: "",
    city: "",
    monthlyListings: "",
    biggestProblem: ""
  },
  user: {
    name: "Troy Massey",
    email: "agent@estatemotion.app",
    subscriptionStatus: "trial",
    creditBalance: 24
  },
  brandKit: {
    id: "",
    name: "Troy Massey",
    brokerage: "Desert North Realty",
    headshotUri: "",
    headshotPath: "",
    logoUri: "",
    logoPath: "",
    phone: "(602) 555-0148",
    email: "troy@example.com",
    website: "troymasseyrealestate.com",
    instagram: "@troysellsaz",
    primaryColor: "#111111",
    accentColor: "#C7A76C",
    ctaText: "Book a private tour",
    complianceEnabled: true,
    listingCourtesyOf: "Listing courtesy of Desert North Realty",
    brokerageDisclaimer: "Brokerage disclaimer placeholder. Agent is licensed in Arizona.",
    equalHousing: true,
    mlsDisclaimer: "MLS disclaimer placeholder. Verify all facts and availability."
  },
  project: {
    id: "",
    title: "Modern Desert Retreat",
    address: "7420 E Vista Drive",
    price: "$1,250,000",
    beds: "4",
    baths: "3.5",
    squareFeet: "3,240",
    neighborhood: "McCormick Ranch",
    city: "Scottsdale",
    listingType: "Just Listed",
    hookText: "Inside this Scottsdale retreat with resort-style living",
    caption: "A polished desert home with generous living spaces, warm natural light, and the indoor-outdoor rhythm Arizona buyers love.",
    cta: "DM me for the full tour",
    hookPreset: "Luxury",
    captionTone: "Luxury",
    reelTheme: "scottsdale-desert-luxury",
    textAnimation: "Luxury minimal",
    musicMood: "Luxury",
    outroVariation: "Headshot + CTA",
    thumbnailPreset: "Inside This Home",
    reelVariations: [],
    brandingVisible: true,
    authenticityMode: true,
    localAgentMode: true,
    introText: "",
    outroText: "",
    contentMode: "listing-reel",
    conversionGoal: "Schedule showing",
    ctaUrl: "",
    qrCodeUrl: "",
    sellerPresentationMode: false,
    investorMetrics: {
      arv: "",
      rehabEstimate: "",
      capRate: "",
      cashFlow: "",
      dealStructure: "",
      assignmentFee: ""
    },
    motionDirectorStatus: {
      status: "idle",
      label: "Motion Director pending",
      reason: "",
      signature: "",
      source: "",
      lastRunAt: "",
      openaiCalls: 0,
      callLimit: 3
    },
    reelPlanEdits: null,
    photos: demoPhotos
  }
};

let state = loadState();
const app = document.querySelector("#app");
let authUser = null;
let remoteWorkspaceLoaded = featureFlags.MOCK_SUPABASE;
let saveTimer = null;
let quietSaveTimer = null;
let motionDirectorInFlightSignature = "";
const temporaryPhotoFiles = new Map();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey));
    return saved ? mergeState(defaultState, saved) : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function mergeState(base, saved) {
  return {
    ...base,
    ...saved,
    authPassword: "",
    authMode: saved.authMode ?? base.authMode,
    authReturnScreen: saved.authReturnScreen ?? base.authReturnScreen,
    pendingExportAfterAuth: Boolean(saved.pendingExportAfterAuth),
    renderQueue: saved.renderQueue ?? base.renderQueue,
    renderJobStatus: saved.renderJobStatus ?? base.renderJobStatus,
    selectedShowcaseId: saved.selectedShowcaseId ?? base.selectedShowcaseId,
    leads: saved.leads ?? base.leads,
    betaFeedback: saved.betaFeedback ?? base.betaFeedback,
    analyticsEvents: saved.analyticsEvents ?? base.analyticsEvents,
    earlyAccessForm: { ...base.earlyAccessForm, ...saved.earlyAccessForm },
    betaFeedbackForm: { ...base.betaFeedbackForm, ...saved.betaFeedbackForm },
    user: { ...base.user, ...saved.user },
    brandKit: { ...base.brandKit, ...saved.brandKit },
    project: {
      ...base.project,
      ...saved.project,
      motionDirectorStatus: { ...base.project.motionDirectorStatus, ...saved.project?.motionDirectorStatus },
      photos: saved.project?.photos ?? base.project.photos
    }
  };
}

function readFeatureFlags() {
  const env = window.ESTATEMOTION_ENV ?? {};
  const params = new URLSearchParams(window.location.search);
  return {
    MOCK_AI: readFlag("MOCK_AI", env, params, true),
    MOCK_RENDERING: readFlag("MOCK_RENDERING", env, params, true),
    MOCK_STRIPE: readFlag("MOCK_STRIPE", env, params, true),
    MOCK_SUPABASE: readFlag("MOCK_SUPABASE", env, params, true),
    SUPABASE_URL: params.get("SUPABASE_URL") || env.SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || "",
    SUPABASE_ANON_KEY: params.get("SUPABASE_ANON_KEY") || env.SUPABASE_ANON_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "",
    SUPABASE_JS_URL: params.get("SUPABASE_JS_URL") || env.SUPABASE_JS_URL || "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
    LISTING_PHOTOS_BUCKET: params.get("LISTING_PHOTOS_BUCKET") || env.LISTING_PHOTOS_BUCKET || "listing-photos",
    SUPABASE_STORAGE_PRIVATE: readFlag("SUPABASE_STORAGE_PRIVATE", env, params, false),
    SUPABASE_SIGNED_URL_TTL_SECONDS: Number(params.get("SUPABASE_SIGNED_URL_TTL_SECONDS") || env.SUPABASE_SIGNED_URL_TTL_SECONDS || 172800),
    OPENAI_ENDPOINT: params.get("OPENAI_ENDPOINT") || env.OPENAI_ENDPOINT || "",
    VISION_CLASSIFICATION_ENDPOINT: params.get("VISION_CLASSIFICATION_ENDPOINT") || env.VISION_CLASSIFICATION_ENDPOINT || "/api/classify-image",
    CREATE_EDIT_PLAN_ENDPOINT: params.get("CREATE_EDIT_PLAN_ENDPOINT") || env.CREATE_EDIT_PLAN_ENDPOINT || "/api/create-edit-plan",
    MUSIC_LUXURY_URL: params.get("MUSIC_LUXURY_URL") || env.MUSIC_LUXURY_URL || "",
    MUSIC_VIRAL_URL: params.get("MUSIC_VIRAL_URL") || env.MUSIC_VIRAL_URL || "",
    MUSIC_MLS_CLEAN_URL: params.get("MUSIC_MLS_CLEAN_URL") || env.MUSIC_MLS_CLEAN_URL || "",
    MUSIC_INVESTOR_URL: params.get("MUSIC_INVESTOR_URL") || env.MUSIC_INVESTOR_URL || "",
    STRIPE_PUBLISHABLE_KEY: params.get("STRIPE_PUBLISHABLE_KEY") || env.STRIPE_PUBLISHABLE_KEY || env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || "",
    STRIPE_CHECKOUT_ENDPOINT: params.get("STRIPE_CHECKOUT_ENDPOINT") || env.STRIPE_CHECKOUT_ENDPOINT || "",
    RENDER_ENDPOINT: params.get("RENDER_ENDPOINT") || env.RENDER_ENDPOINT || ""
  };
}

function readFlag(key, env, params, fallback) {
  const value = params.get(key) ?? localStorage.getItem(`ESTATEMOTION_${key}`) ?? env[key];
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1";
}

function saveState() {
  if (shouldUseLocalPersistence()) {
    localStorage.setItem(storageKey, JSON.stringify(stateForStorage()));
    return;
  }
  scheduleRemoteSave();
}

function saveStateQuietly() {
  window.clearTimeout(quietSaveTimer);
  quietSaveTimer = window.setTimeout(() => {
    if (shouldUseLocalPersistence()) {
      localStorage.setItem(storageKey, JSON.stringify(stateForStorage()));
      return;
    }
    scheduleRemoteSave();
  }, 350);
}

function shouldUseLocalPersistence() {
  return featureFlags.MOCK_SUPABASE || isDemoRoute() || !authUser || !remoteWorkspaceLoaded;
}

function stateForStorage() {
  return {
    ...state,
    authPassword: "",
    loading: state.loading === "Saving your photos..." || state.loading === "Preparing final render..." ? "" : state.loading
  };
}

function appModeLabel() {
  return featureFlags.MOCK_AI || featureFlags.MOCK_RENDERING || featureFlags.MOCK_STRIPE || featureFlags.MOCK_SUPABASE ? "Mock Mode" : "Production Mode";
}

function appModeClass() {
  return appModeLabel() === "Production Mode" ? "live" : "mock";
}

function supabaseEnvError() {
  if (featureFlags.MOCK_SUPABASE) return "";
  const missing = [];
  if (!featureFlags.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!featureFlags.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
  if (!missing.length) return "";
  return `Supabase is in production mode but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. Add them in Vercel Environment Variables, or set MOCK_SUPABASE=true for local demo mode.`;
}

function localApiEnvWarning() {
  if (!window.ESTATEMOTION_API_ENV_UNAVAILABLE) return "";
  return "Local fallback active: /api/env is unavailable on the static dev server, so EstateMotion is using env.js. This is expected locally; Vercel serves /api/env in production.";
}

function isDemoRoute() {
  return ["demo", "beta", "waitlist"].includes(routePath());
}

function isProtectedAppRoute() {
  return routePath() === "app";
}

function routePath() {
  return window.location.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
}

function scheduleRemoteSave() {
  if (!window.EstateMotionSupabase?.enabled() || !authUser || !remoteWorkspaceLoaded) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      const ids = await window.EstateMotionSupabase.saveWorkspace(state, authUser);
      if (ids.projectId && state.project.id !== ids.projectId) state.project.id = ids.projectId;
      if (ids.brandKitId && state.brandKit.id !== ids.brandKitId) state.brandKit.id = ids.brandKitId;
      if (ids.warnings?.length) console.warn("Supabase profile sync warning:", ids.warnings.join(" "));
    } catch (error) {
      console.error(error);
      state = { ...state, error: error.message || "Supabase save failed." };
      render();
    }
  }, 500);
}

function setState(patch) {
  state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
  saveState();
  render();
}

function setStateQuietly(patch) {
  state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
  saveStateQuietly();
}

function showToast(message, type = "success") {
  const toast = { id: `toast-${Date.now()}`, message, type };
  state = { ...state, toasts: [...state.toasts.slice(-2), toast] };
  saveState();
  render();
  setTimeout(() => {
    state = { ...state, toasts: state.toasts.filter((item) => item.id !== toast.id) };
    saveState();
    render();
  }, 2800);
}

function setError(message) {
  setState({ error: message, loading: "" });
  showToast(message, "error");
}

function trackEvent(type, metadata = {}) {
  const event = {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    metadata,
    createdAt: new Date().toISOString()
  };
  state = { ...state, analyticsEvents: [...state.analyticsEvents, event] };
  saveState();
}

function analyticsSummary() {
  const events = state.analyticsEvents;
  const pricingClicks = events.filter((event) => event.type === "pricing_click");
  const pricingCounts = pricingClicks.reduce((counts, event) => {
    const plan = event.metadata.plan ?? "Unknown";
    counts[plan] = (counts[plan] ?? 0) + 1;
    return counts;
  }, {});
  const mostClicked = Object.entries(pricingCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None yet";
  const templateCounts = events.filter((event) => event.type === "template_select").reduce((counts, event) => {
    const templateId = event.metadata.templateId ?? "Unknown";
    counts[templateId] = (counts[templateId] ?? 0) + 1;
    return counts;
  }, {});
  const hookCounts = events.filter((event) => event.type === "hook_preset_apply").reduce((counts, event) => {
    const preset = event.metadata.preset ?? "Unknown";
    counts[preset] = (counts[preset] ?? 0) + 1;
    return counts;
  }, {});
  const visits = events.filter((event) => event.type === "demo_visit").length;
  const exportStyles = events.filter((event) => event.type === "queue_content_pack").reduce((counts, event) => {
    const style = event.metadata.templateId || "unknown";
    counts[style] = (counts[style] || 0) + 1;
    return counts;
  }, {});
  const contentModeCounts = events.reduce((counts, event) => {
    const mode = event.metadata.contentMode;
    if (mode) counts[mode] = (counts[mode] || 0) + 1;
    return counts;
  }, {});
  const leads = state.leads.length;
  const leadSubmissions = events.filter((event) => event.type === "early_access_submit").length;
  const exportIntent = events.filter((event) => ["export_manifest_click", "export_preview_click", "export_copy_click", "queue_content_pack"].includes(event.type)).length;
  return {
    visits,
    leads,
    conversionRate: visits ? Math.min(100, Math.round((leadSubmissions / visits) * 100)) : 0,
    mostClicked,
    exportIntent,
    mostUsedTemplate: Object.entries(templateCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None yet",
    mostUsedHook: Object.entries(hookCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None yet",
    mostExportedStyle: Object.entries(exportStyles).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None yet",
    mostUsedContentMode: Object.entries(contentModeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None yet",
    recommendation: recommendationForCurrentAgent()
  };
}

function recommendationForCurrentAgent() {
  if (state.project.contentMode?.includes("investor") || state.project.contentMode?.includes("wholesale")) return "Agents like you should lead with Investor / Wholesale and a direct Investor details CTA.";
  if (state.project.contentMode === "seller-lead-magnet") return "Use Personal Brand Agent with a Seller consultation CTA to convert listing appointments.";
  if (state.project.city === "Scottsdale" || state.project.captionTone === "Luxury") return "Luxury Listing with slow cinematic pacing is the strongest fit for this market position.";
  return "Start with Listing Reel, then repeat with Neighborhood Spotlight for weekly authority.";
}

function recommendedTemplateForGoal() {
  return contentGoalRecommendations[state.project.contentMode || "listing-reel"] || contentGoalRecommendations["listing-reel"];
}

function recommendedContentModeForTemplate(templateId) {
  return Object.entries(contentGoalRecommendations).find(([, recommendation]) => recommendation.template === templateId)?.[0] || "listing-reel";
}

function contentModeName(modeId = state.project.contentMode) {
  return contentModes.find((mode) => mode.id === modeId)?.name || "Listing Reel";
}

function screenToStep(screen) {
  const order = ["upload", "template", "processing", "preview", "export"];
  return order.indexOf(screen) + 1;
}

function routeFromUrl() {
  const path = routePath();
  if (path === "demo") return "demo";
  if (path === "beta" || path === "waitlist") return "beta";
  if (path === "app" && state.screen === "demo") return "dashboard";
  return "";
}

function navigate(screen) {
  setState({ screen });
  setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
}

function maybeStartOnboarding() {
  const route = routeFromUrl();
  if (route) {
    state.screen = route;
    saveState();
    return;
  }
  if (featureFlags.MOCK_SUPABASE && state.screen === "auth") {
    state.screen = "dashboard";
    state.authStatus = "mock";
    saveState();
    return;
  }
  if (!state.hasOnboarded && state.screen === "dashboard") {
    state.screen = "onboarding";
    saveState();
  }
}

async function bootstrapSupabase() {
  if (featureFlags.MOCK_SUPABASE || !isProtectedAppRoute()) {
    remoteWorkspaceLoaded = true;
    return;
  }
  const envError = supabaseEnvError();
  if (envError) {
    state = { ...state, authStatus: "signed-out", error: envError };
    render();
    return;
  }
  try {
    const session = await window.EstateMotionSupabase.getSession();
    authUser = session.user;
    if (!authUser) {
      state = { ...state, authStatus: "signed-out" };
      render();
      return;
    }
    state = { ...state, authStatus: "loading", user: { ...state.user, email: authUser.email || state.user.email } };
    render();
    const workspace = await window.EstateMotionSupabase.loadWorkspace(authUser.id);
    remoteWorkspaceLoaded = true;
    state = mergeRemoteWorkspace(state, workspace);
    state.authStatus = "signed-in";
    if (state.screen === "auth" && state.authReturnScreen) state.screen = state.authReturnScreen;
    if (!state.hasOnboarded && state.brandKit.name && state.brandKit.brokerage) state.hasOnboarded = true;
    maybeStartOnboarding();
    render();
  } catch (error) {
    console.error(error);
    state = { ...state, authStatus: "error", error: error.message || "Supabase connection failed." };
    render();
  }
}

function mergeRemoteWorkspace(current, workspace) {
  const keepLocalProject = current.pendingExportAfterAuth || current.project?.photos?.some((photo) => photo.localOnly || isLocalOnlyUrl(photo.uri) || isLocalOnlyUrl(photo.objectUrl));
  return {
    ...current,
    user: workspace.user ? {
      ...current.user,
      name: workspace.user.full_name || current.user.name,
      email: workspace.user.email || current.user.email,
      subscriptionStatus: workspace.user.subscription_status || current.user.subscriptionStatus,
      creditBalance: workspace.user.credit_balance ?? current.user.creditBalance
    } : current.user,
    brandKit: workspace.brandKit ? { ...current.brandKit, ...workspace.brandKit } : current.brandKit,
    project: workspace.project && !keepLocalProject ? { ...current.project, ...workspace.project, photos: workspace.project.photos?.length ? workspace.project.photos : current.project.photos } : current.project
  };
}

async function getCurrentSession() {
  const envError = supabaseEnvError();
  if (envError) throw new Error(envError);
  if (!window.EstateMotionSupabase?.getSession) throw new Error("Supabase auth helper is unavailable. Refresh the page and try again.");
  return window.EstateMotionSupabase.getSession();
}

function authCredentials() {
  return {
    email: String(state.authEmail || "").trim(),
    password: String(state.authPassword || "")
  };
}

function validateAuthCredentials(email, password, { requirePassword = true } = {}) {
  if (!email) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (requirePassword && !password) return "Enter your password.";
  if (requirePassword && password.length < 6) return "Password must be at least 6 characters.";
  return "";
}

function friendlyAuthError(error, fallback = "Authentication failed.") {
  const message = String(error?.message || fallback);
  const lower = message.toLowerCase();
  if (lower.includes("invalid login") || lower.includes("invalid credentials")) return "Invalid email or password. Check your login details and try again.";
  if (lower.includes("already registered") || lower.includes("already exists") || lower.includes("user already")) return "That email is already registered. Switch to Sign In to continue.";
  if (lower.includes("password")) return message.includes("Password") ? message : "Password is too weak or invalid. Use at least 6 characters.";
  if (lower.includes("confirm") || lower.includes("verification")) return "Email confirmation is required. Check your inbox, then return to export your video.";
  if (lower.includes("rate")) return "Too many auth attempts. Wait a moment, then try again.";
  if (lower.includes("supabase") || lower.includes("environment")) return message;
  return message || fallback;
}

async function signInWithMagicLink() {
  const envError = supabaseEnvError();
  if (envError) {
    setError(envError);
    return;
  }
  const { email } = authCredentials();
  const validation = validateAuthCredentials(email, "", { requirePassword: false });
  if (validation) {
    setError(validation);
    return;
  }
  setState({ loading: "Sending sign-in link...", error: "" });
  try {
    await window.EstateMotionSupabase.signInWithEmail(email);
    setState({ loading: "", authStatus: "email-sent" });
    showToast("Check your email for the sign-in link");
  } catch (error) {
    setError(friendlyAuthError(error, "Email sign-in failed."));
  }
}

async function signInWithGoogle() {
  const envError = supabaseEnvError();
  if (envError) {
    setError(envError);
    return;
  }
  setState({ loading: "Opening Google sign-in...", error: "" });
  try {
    await window.EstateMotionSupabase.signInWithGoogle();
  } catch (error) {
    setError(friendlyAuthError(error, "Google sign-in failed."));
  }
}

async function signInWithEmail(email = authCredentials().email, password = authCredentials().password) {
  const envError = supabaseEnvError();
  if (envError) {
    setError(envError);
    return;
  }
  const validation = validateAuthCredentials(email, password);
  if (validation) {
    setError(validation);
    return;
  }
  setState({ loading: "Signing in...", error: "" });
  try {
    const result = await window.EstateMotionSupabase.signInWithPassword(email, password);
    await completeAuthResult(result, "Signed in");
  } catch (error) {
    setError(friendlyAuthError(error, "Email/password sign in failed."));
  }
}

async function signInWithPassword() {
  const { email, password } = authCredentials();
  return signInWithEmail(email, password);
}

async function signUpWithEmail(email = authCredentials().email, password = authCredentials().password) {
  const envError = supabaseEnvError();
  if (envError) {
    setError(envError);
    return;
  }
  const validation = validateAuthCredentials(email, password);
  if (validation) {
    setError(validation);
    return;
  }
  setState({ loading: "Creating account...", error: "" });
  try {
    const result = await window.EstateMotionSupabase.signUpWithPassword(email, password);
    if (Array.isArray(result.user?.identities) && result.user.identities.length === 0) {
      setError("That email is already registered. Switch to Sign In to continue.");
      return;
    }
    if (!result.session) {
      authUser = null;
      setState({ loading: "", authStatus: "email-sent", authPassword: "", error: "Email confirmation required. Check your inbox, then sign in to export your video." });
      showToast("Check your email to confirm your account", "success");
      return;
    }
    await completeAuthResult(result, "Account created");
  } catch (error) {
    setError(friendlyAuthError(error, "Account creation failed."));
  }
}

async function signUpWithPassword() {
  const { email, password } = authCredentials();
  return signUpWithEmail(email, password);
}

async function completeAuthResult(result, successMessage = "Signed in") {
  authUser = result?.user || result?.session?.user || null;
  if (!authUser) {
    const session = await getCurrentSession();
    authUser = session.user || null;
  }
  if (!authUser) throw new Error("Email confirmation required. Check your inbox, then sign in to export your video.");
  showToast(successMessage);
  await continueAfterAuth();
}

async function continueAfterAuth() {
  const returnScreen = state.authReturnScreen || "export";
  const shouldQueueExport = state.pendingExportAfterAuth && returnScreen === "export";
  setState({ loading: "Signed in", authStatus: "signed-in", authPassword: "", screen: returnScreen, error: "" });
  try {
    const session = await getCurrentSession();
    authUser = session.user || authUser;
    if (!authUser?.id) throw new Error("Supabase session is missing. Sign in again before exporting.");
    remoteWorkspaceLoaded = false;
    try {
      const workspace = await window.EstateMotionSupabase.loadWorkspace(authUser.id);
      state = mergeRemoteWorkspace(state, workspace);
      state = { ...state, user: { ...state.user, email: authUser.email || state.user.email } };
      saveState();
    } catch (workspaceError) {
      console.warn("Supabase workspace load warning:", workspaceError);
      showToast("Signed in. Existing workspace could not be loaded, so EstateMotion kept this local project.", "error");
    }
    setState({ loading: "Saving your photos...", authStatus: "signed-in", screen: returnScreen, error: "" });
    await persistTemporaryPhotosAfterAuth();
    setState((current) => ({
      ...current,
      loading: "Preparing final render...",
      project: {
        ...current.project,
        motionDirectorStatus: motionDirectorIdleStatus(current.project.motionDirectorStatus)
      }
    }));
    await window.EstateMotionSupabase?.saveWorkspace?.(state, authUser);
    remoteWorkspaceLoaded = true;
    setState((current) => ({
      ...current,
      loading: "",
      pendingExportAfterAuth: false,
      authReturnScreen: "dashboard",
      authStatus: "signed-in",
      project: current.project
    }));
    if (shouldQueueExport) {
      showToast("Photos saved. Starting export.");
      window.setTimeout(() => queueContentPack(), 0);
    }
  } catch (error) {
    const message = friendlyAuthError(error, "Upload failed. Try again.");
    setState({ loading: "", pendingExportAfterAuth: shouldQueueExport, screen: returnScreen, error: message });
    showToast(message, "error");
  }
}

async function signOut() {
  try {
    await window.EstateMotionSupabase.signOut();
    authUser = null;
    remoteWorkspaceLoaded = false;
    state = { ...structuredClone(defaultState), authStatus: "signed-out", screen: "dashboard", toasts: [] };
    render();
  } catch (error) {
    setError(error.message || "Sign out failed.");
  }
}

function selectedTemplate() {
  return templates.find((template) => template.id === normalizeTemplateId(state.selectedTemplateId)) ?? templates[0];
}

function normalizeTemplateId(templateId) {
  const legacy = {
    "first-time-buyer": "agent-brand-builder",
    "just-listed-fast-cut": "viral-fast-cut"
  };
  return legacy[templateId] || templateId;
}

function orderedPhotos() {
  return [...state.project.photos].sort((a, b) => a.order - b.order);
}

function categorizePhoto(fileName) {
  return classifyPhoto(fileName).category;
}

function classifyPhoto(fileName, index = 0) {
  if (window.EstateMotionReel?.imageClassifier) {
    const result = window.EstateMotionReel.imageClassifier.classifyPhoto({ fileName, uploadOrder: index });
    return normalizeClassification(result);
  }
  const name = String(fileName || "").toLowerCase().replaceAll("_", "-");
  const scores = Object.entries(sceneIntelligence).map(([category, config]) => {
    const keywordHits = config.keywords.filter((keyword) => name.includes(keyword)).length;
    const orderBoost = sceneOrderBoost(category, index);
    const base = category === "Detail shots" ? 0.24 : 0.18;
    const score = Math.min(0.97, base + keywordHits * 0.28 + orderBoost);
    return { category, score };
  }).sort((a, b) => b.score - a.score);
  const winner = scores[0] ?? { category: "Detail shots", score: 0.5 };
  const alternatives = scores.slice(1, 3).map((item) => item.category);
  return {
    category: winner.category,
    confidence: Math.round(winner.score * 100),
    pipelineCategory: sceneToPipelineCategory(winner.category),
    tags: [],
    suggestedCorrections: alternatives,
    intelligence: sceneIntelligence[winner.category]
  };
}

function normalizeClassification(result) {
  const category = pipelineToSceneCategory(result.category);
  return {
    category,
    pipelineCategory: result.category,
    confidence: Math.max(0, Math.min(100, Math.round(Number(result.confidence || 0)))),
    tags: result.tags || [],
    visibleFeatures: result.visibleFeatures || result.tags || [],
    description: result.description || "",
    classificationSource: result.source || "fallback",
    fallbackReason: result.fallbackReason || "",
    suggestedCorrections: (result.suggestedCorrections || []).map(pipelineToSceneCategory),
    intelligence: sceneIntelligence[category] || sceneIntelligence["Detail shots"]
  };
}

function pipelineToSceneCategory(category) {
  const map = {
    "exterior hero": "Exterior hero",
    kitchen: "Kitchen",
    "living room": "Living room",
    bedroom: "Primary bedroom",
    bathroom: "Bathroom",
    "backyard/outdoor": "Backyard / pool",
    amenity: "Neighborhood / amenities",
    "detail/other": "Detail shots"
  };
  return map[category] || category || "Detail shots";
}

function sceneToPipelineCategory(category) {
  const normalized = sceneLabel(category);
  const map = {
    "Exterior hero": "exterior hero",
    Kitchen: "kitchen",
    "Living room": "living room",
    Dining: "living room",
    "Primary bedroom": "bedroom",
    Bathroom: "bathroom",
    "Backyard / pool": "backyard/outdoor",
    "Neighborhood / amenities": "amenity",
    "Entry / front door": "exterior hero",
    "Detail shots": "detail/other"
  };
  return map[normalized] || "detail/other";
}

function sceneOrderBoost(category, index) {
  if (index === 0 && category === "Exterior hero") return 0.24;
  if (index === 1 && category === "Entry / front door") return 0.16;
  if (index >= 2 && index <= 4 && ["Kitchen", "Living room", "Dining"].includes(category)) return 0.08;
  if (index >= 5 && ["Primary bedroom", "Bathroom", "Backyard / pool"].includes(category)) return 0.06;
  return 0;
}

function sceneLabel(category) {
  if (category === "Exterior") return "Exterior hero";
  if (category === "Entry transition") return "Entry / front door";
  if (category === "Backyard") return "Backyard / pool";
  if (category === "Interior reveal") return "Living room";
  if (category === "CTA close") return "Detail shots";
  return category;
}

function sceneConfidence(photo) {
  return Math.max(35, Math.min(99, Number(photo.confidence ?? classifyPhoto(photo.fileName, photo.order - 1).confidence)));
}

function sceneSuggestions(photo) {
  return photo.suggestedCorrections?.length ? photo.suggestedCorrections : classifyPhoto(photo.fileName, photo.order - 1).suggestedCorrections;
}

function applyHookPreset(preset) {
  const template = hookPresets[preset];
  if (!template) return;
  const hook = hydratePreset(template);
  trackEvent("hook_preset_apply", { preset });
  setState((current) => ({ ...current, project: { ...current.project, hookPreset: preset, hookText: hook } }));
  showToast(`${preset} hook applied`);
}

function hydratePreset(template) {
  return String(template || "")
    .replace("{city}", state.project.city || "this market")
    .replace("{price}", state.project.price || "$X");
}

const unsupportedClaimPatterns = [
  /\bbest deal\b/gi,
  /\bguaranteed\b/gi,
  /\bperfect investment\b/gi,
  /\bcan'?t lose\b/gi,
  /\brisk[- ]free\b/gi,
  /\bhighest roi\b/gi
];

function enforceMlsSafeCaption(value, claimConfirmed = false) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!claimConfirmed) {
    unsupportedClaimPatterns.forEach((pattern) => {
      text = text.replace(pattern, "featured opportunity");
    });
  }
  return text.slice(0, 140);
}

function captionNeedsManualClaimConfirmation(value) {
  return unsupportedClaimPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(String(value || ""));
  });
}

function createReelVariations() {
  return Object.entries(reelVariationPresets).map(([name, settings]) => ({
    name,
    hook: `${name}: ${state.project.hookText || hydratePreset(hookPresets.Luxury)}`,
    settings
  }));
}

function selectedReelTheme() {
  return reelThemes.find((theme) => theme.id === state.project.reelTheme) ?? reelThemes[0];
}

function selectedShowcase() {
  return showcaseProjects.find((project) => project.id === state.selectedShowcaseId) ?? showcaseProjects[0];
}

function cloneShowcaseProject(showcase) {
  return {
    ...structuredClone(showcase.project),
    photos: showcase.project.photos.map((photo, index) => ({ ...photo, order: index + 1 }))
  };
}

function sceneToPipelineCategorySafe(category) {
  const map = {
    "Exterior hero": "exterior hero",
    Exterior: "exterior hero",
    Kitchen: "kitchen",
    "Living room": "living room",
    "Primary bedroom": "bedroom",
    Bedroom: "bedroom",
    Bathroom: "bathroom",
    "Backyard / pool": "backyard/outdoor",
    Backyard: "backyard/outdoor",
    "Entry / front door": "exterior hero",
    "Neighborhood / amenities": "amenity",
    "Detail shots": "detail/other"
  };
  return map[category] || "detail/other";
}

function loadBetaSampleListing() {
  setState((current) => ({
    ...current,
    selectedTemplateId: "desert-luxury",
    selectedScene: 0,
    renderQueue: [],
    exportResult: null,
    error: "",
    project: {
      ...structuredClone(betaSampleListing),
      motionDirectorStatus: motionDirectorIdleStatus(current.project.motionDirectorStatus),
      motionDirectorPlan: null,
      reelPlanEdits: null
    },
    screen: "processing"
  }));
  showToast("Sample listing loaded");
}

function loadShowcaseProject(id) {
  const showcase = showcaseProjects.find((project) => project.id === id);
  if (!showcase) {
    setError("Showcase project could not be loaded.");
    return;
  }
  setState((current) => ({
    ...current,
    selectedShowcaseId: showcase.id,
    selectedTemplateId: showcase.selectedTemplateId,
    selectedScene: 0,
    renderQueue: [],
    exportResult: null,
    error: "",
    project: cloneShowcaseProject(showcase),
    screen: "preview"
  }));
  showToast(`${showcase.title} loaded for demo`);
}

function topFeatures() {
  const photos = orderedPhotos().map((photo) => sceneLabel(photo.category));
  const featurePool = [
    photos.includes("Kitchen") ? "A kitchen designed for daily living and social hosting" : "",
    photos.includes("Living room") ? "Open living spaces with strong natural-light appeal" : "",
    photos.includes("Backyard / pool") ? "Outdoor space that extends the Arizona lifestyle" : "",
    photos.includes("Primary bedroom") ? "A primary suite that feels calm and private" : "",
    `${state.project.neighborhood} location in ${state.project.city}`
  ].filter(Boolean);
  return featurePool.slice(0, 3);
}

function investorEstimateSummary() {
  const metrics = state.project.investorMetrics || {};
  const arv = numericEstimate(metrics.arv);
  const rehab = numericEstimate(metrics.rehabEstimate);
  const assignment = numericEstimate(metrics.assignmentFee);
  const projectedSpread = Math.max(0, arv - rehab - assignment);
  return {
    arv,
    rehab,
    assignment,
    projectedSpread,
    dealStructure: metrics.dealStructure || "Estimate-only deal structure",
    capRate: metrics.capRate || "",
    cashFlow: metrics.cashFlow || ""
  };
}

function numericEstimate(value) {
  const numeric = Number(String(value || "").replace(/[$,\s%]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function money(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "Estimate needed";
  return `$${Number(value).toLocaleString()}`;
}

function modeSpecificOverlay(scene, index, total) {
  const mode = state.project.contentMode || "listing-reel";
  const metrics = investorEstimateSummary();
  const area = state.project.neighborhood || state.project.city || "local market";
  const base = {
    mode,
    modeName: contentModeName(mode),
    label: "",
    headline: "",
    lines: [],
    disclaimer: "",
    variant: "standard"
  };
  if (mode === "seller-lead-magnet") {
    return {
      ...base,
      label: "Seller Preview",
      headline: index === 0 ? "See what your home could look like online" : "Listing marketing that feels premium before buyers arrive",
      lines: ["Your photos", selectedTemplate().name, state.project.conversionGoal || "Seller consultation"],
      disclaimer: "Marketing preview only. No sale price or outcome is guaranteed.",
      variant: "seller"
    };
  }
  if (mode === "investor-breakdown") {
    return {
      ...base,
      label: "Investor Estimate",
      headline: index === 0 ? "Deal snapshot" : "Estimate-only investor angle",
      lines: [`ARV est. ${money(metrics.arv)}`, `Rehab est. ${money(metrics.rehab)}`, `Projected spread est. ${money(metrics.projectedSpread)}`],
      disclaimer: "All figures are estimates and require independent verification.",
      variant: "investor"
    };
  }
  if (mode === "wholesale-opportunity") {
    return {
      ...base,
      label: "Wholesale Opportunity",
      headline: index === 0 ? "Assignment-style deal summary" : metrics.dealStructure,
      lines: [`ARV est. ${money(metrics.arv)}`, `Rehab est. ${money(metrics.rehab)}`, `Assignment est. ${money(metrics.assignment)}`],
      disclaimer: "Wholesale/investor figures are estimates, not guarantees or financial advice.",
      variant: "wholesale"
    };
  }
  if (mode === "neighborhood-spotlight") {
    return {
      ...base,
      label: "Neighborhood Spotlight",
      headline: index === 0 ? `${area} lifestyle` : sceneLabel(scene.photo?.category || scene.category),
      lines: [`${state.project.city || area} living`, "Local context", state.project.conversionGoal || "Ask me about this area"],
      disclaimer: "Lifestyle captions are based on listing location and uploaded photos.",
      variant: "neighborhood"
    };
  }
  if (mode === "agent-brand") {
    return {
      ...base,
      label: "Agent Authority",
      headline: index === total - 1 ? `${state.brandKit.name || "Your agent"} can help you move next` : "Local real estate strategy",
      lines: [state.brandKit.brokerage || state.project.brokerage || "Brokerage", state.brandKit.phone || state.project.email || "", state.project.conversionGoal || "Follow for local real estate strategy"].filter(Boolean),
      disclaimer: "Agent contact CTA card.",
      variant: "agent"
    };
  }
  return base;
}

function generateReelVariations() {
  setState((current) => ({ ...current, project: { ...current.project, reelVariations: createReelVariations() } }));
  showToast("3 reel variations generated");
}

function aiCopy() {
  const project = state.project;
  const template = selectedTemplate();
  const localTone = {
    Phoenix: "central Phoenix convenience and everyday desert living",
    Scottsdale: "Scottsdale polish, resort energy, and indoor-outdoor appeal",
    Arcadia: "Arcadia charm, mature streets, and lifestyle-driven living",
    "Paradise Valley": "Paradise Valley privacy, views, and refined desert luxury",
    Tempe: "Tempe access, energy, and lock-and-leave convenience",
    Chandler: "Chandler comfort, schools, and easy East Valley access",
    Gilbert: "Gilbert neighborhood warmth and move-in-ready appeal",
    Mesa: "Mesa value, space, and desert views"
  };
  const phrase = project.localAgentMode ? localTone[project.city] || `${project.city} lifestyle appeal` : "a location buyers will remember";
  const hook = project.hookText || `${project.listingType}: ${project.beds} bed ${project.city} home`;
  const highlights = [
    `${project.beds} beds, ${project.baths} baths, and ${project.squareFeet} sq ft`,
    `${project.neighborhood} location with ${phrase}`,
    `${project.captionTone || "Luxury"} tone with clean, authentic listing-photo motion`
  ];
  const toneLine = captionTonePresets[project.captionTone] ?? captionTonePresets.Luxury;
  return {
    hook,
    description: `${project.address} pairs ${phrase} with polished interiors, strong curb appeal, and a short-form video story built for modern buyers.`,
    highlights,
    instagramCaption: `${hook}\n\n${project.caption}\n\n${toneLine}\n\n${project.cta}`,
    hashtags: [`#${project.city}RealEstate`, "#ArizonaHomes", "#ListingReel", "#RealEstateMarketing", "#EstateMotion"],
    voiceoverScript: `${hook}. Here are three things buyers will notice: ${highlights.join(". ")}. ${project.cta}.`
  };
}

function contentPack() {
  const copy = aiCopy();
  const photos = orderedPhotos();
  const byCategory = (categories) => photos.filter((photo) => categories.includes(sceneLabel(photo.category))).map((photo) => photo.id);
  return [
    { id: "full", title: "Full Property Reel", format: "9:16", duration: 28, hook: copy.hook, photoIds: photos.map((photo) => photo.id) },
    { id: "kitchen", title: "Kitchen Highlight", format: "9:16", duration: 12, hook: "The kitchen buyers will replay", photoIds: byCategory(["Kitchen", "Detail shots", "Living room"]) },
    { id: "curb", title: "Exterior Curb Appeal Reel", format: "1:1", duration: 10, hook: `${state.project.city} curb appeal in one glance`, photoIds: byCategory(["Exterior hero", "Backyard / pool", "Neighborhood / amenities"]) },
    { id: "story", title: "Open House Story", format: "9:16 Story", duration: 15, hook: state.project.listingType === "Open House" ? "Open house this week" : "Tour this listing", photoIds: byCategory(["Exterior hero", "Entry / front door", "Kitchen", "Living room"]) },
    { id: "top3", title: "Top 3 Features Reel", format: "9:16", duration: 18, hook: "3 things buyers will notice first", photoIds: photos.filter((photo) => ["Kitchen", "Living room", "Primary bedroom", "Backyard / pool"].includes(sceneLabel(photo.category))).slice(0, 5).map((photo) => photo.id) },
    { id: "neighborhood", title: "Neighborhood Teaser", format: "9:16", duration: 12, hook: `${state.project.neighborhood || state.project.city} lifestyle in under 15 seconds`, photoIds: byCategory(["Neighborhood / amenities", "Exterior hero", "Backyard / pool"]) },
    { id: "investor", title: "Investor Angle", format: "1:1", duration: 16, hook: "The buyer-demand angle investors should see", photoIds: photos.slice(0, 6).map((photo) => photo.id) },
    { id: "luxury", title: "Luxury Angle", format: "16:9", duration: 22, hook: copy.hook, photoIds: photos.filter((photo) => sceneConfidence(photo) >= 65).map((photo) => photo.id) },
    { id: "viral", title: "Viral Social Angle", format: "9:16", duration: 11, hook: "Would you live here?", photoIds: photos.slice(0, 5).map((photo) => photo.id) },
    { id: "copy", title: "Caption + Hashtags", format: "Text", duration: 0, hook: copy.instagramCaption, photoIds: [] }
  ];
}

function contentPackCard(item) {
  const queueItem = state.renderQueue.find((job) => job.packId === item.id);
  return `
    <article class="export-card pack-card">
      <div>
        <strong>${item.title}</strong>
        <small>${item.format}${item.duration ? ` - ${item.duration}s` : ""} - ${escapeHtml(item.hook)}</small>
      </div>
      <span class="queue-pill ${queueItem?.status ?? "queued"}">${queueItem?.status ?? "not queued"}</span>
    </article>
  `;
}

function renderQueueSummary() {
  if (!state.renderQueue.length) {
    return `<section class="panel compact"><div class="section-title"><p>Render queue</p><h3>No queued renders yet</h3></div><p class="muted">Queue the content pack from Export when you are ready.</p></section>`;
  }
  return `
    <section class="panel compact">
      <div class="section-title"><p>Render queue</p><h3>${state.renderQueue.length} assets</h3></div>
      ${state.renderQueue.slice(0, 4).map((job) => `<div class="queue-row"><span>${escapeHtml(job.title)}</span><b class="${job.status}">${job.status}</b></div>`).join("")}
    </section>
  `;
}

function updateProject(key, value, options = {}) {
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({ ...current, error: "", project: { ...current.project, [key]: value } }));
}

function updateProjectAndResetPlan(key, value, options = {}) {
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({ ...current, error: "", project: { ...current.project, [key]: value, reelPlanEdits: null, motionDirectorPlan: null, motionDirectorStatus: motionDirectorIdleStatus(current.project.motionDirectorStatus) } }));
}

function updateBrand(key, value, options = {}) {
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({ ...current, error: "", brandKit: { ...current.brandKit, [key]: value } }));
}

function updateEarlyAccess(key, value, options = {}) {
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({ ...current, error: "", earlyAccessForm: { ...current.earlyAccessForm, [key]: value } }));
}

function updateBetaFeedback(key, value, options = {}) {
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({ ...current, error: "", betaFeedbackForm: { ...current.betaFeedbackForm, [key]: value } }));
}

function resetProject() {
  setState({ ...structuredClone(defaultState), screen: "create" });
  showToast("Demo project reset");
}

function resetDemoMode() {
  localStorage.removeItem(storageKey);
  localStorage.removeItem(legacyStorageKey);
  state = { ...structuredClone(defaultState), hasOnboarded: true, screen: "dashboard", toasts: [] };
  saveState();
  render();
  showToast("Demo mode restored");
}

function validateBrandKit() {
  if (!state.brandKit.name.trim()) return "Agent name is required.";
  if (!state.brandKit.brokerage.trim()) return "Brokerage is required.";
  return "";
}

function validateProjectBasics() {
  const brandError = validateBrandKit();
  if (brandError) return brandError;
  if (!state.project.address.trim()) return "Property address is required.";
  if (!state.project.price.trim()) return "Price is required before rendering.";
  if (!String(state.project.beds || "").trim()) return "Beds are required before rendering.";
  if (!String(state.project.baths || "").trim()) return "Baths are required before rendering.";
  if (!String(state.project.squareFeet || "").trim()) return "Square footage is required before rendering.";
  if (!String(state.project.city || state.project.neighborhood || "").trim()) return "City or neighborhood is required before rendering.";
  return "";
}

function validateMarketingOSFields() {
  const mode = state.project.contentMode || "listing-reel";
  const metrics = state.project.investorMetrics || {};
  const requiresInvestorMath = ["investor-breakdown", "wholesale-opportunity"].includes(mode);
  if (requiresInvestorMath) {
    const arvError = validateNumericEstimate("ARV", metrics.arv);
    if (arvError) return arvError;
    const rehabError = validateNumericEstimate("Rehab estimate", metrics.rehabEstimate);
    if (rehabError) return rehabError;
    if (!state.project.reelPlanEdits?.claimConfirmed) {
      return "Investor and wholesale overlays must be manually confirmed as estimates before export.";
    }
  }
  if (mode === "seller-lead-magnet") {
    const unsafeSellerCopy = [state.project.introText, state.project.outroText, state.project.cta, state.project.conversionGoal].join(" ");
    if (/\b(guarantee|guaranteed|will sell|certain sale|highest price)\b/i.test(unsafeSellerCopy)) {
      return "Seller lead content cannot imply a guaranteed sale price or guaranteed sale outcome.";
    }
  }
  return "";
}

function validateNumericEstimate(label, value) {
  const raw = String(value || "").trim();
  if (!raw) return `${label} is required for investor/wholesale overlays and must be marked as an estimate.`;
  const numeric = Number(raw.replace(/[$,\s%]/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return `${label} must be numeric. Use estimate values only.`;
  return "";
}

function validatePhotos() {
  if (orderedPhotos().length < 3) return "Upload or add at least 3 listing photos.";
  const missingUrl = orderedPhotos().find((photo) => !photoRenderUrl(photo));
  if (missingUrl) return `${missingUrl.fileName || "A listing photo"} is missing a usable preview URL. Remove it and upload again.`;
  return "";
}

function validateTemplate() {
  if (!templates.some((template) => template.id === normalizeTemplateId(state.selectedTemplateId))) return "Choose a template before previewing.";
  return "";
}

function guard(error, next) {
  if (error) {
    setError(error);
    return;
  }
  setState({ error: "" });
  next();
}

function field(label, key, options = {}) {
  const value = state.project[key] ?? "";
  if (options.type === "textarea") {
    return `<div class="field"><label>${label}</label><textarea data-project="${key}">${escapeHtml(value)}</textarea></div>`;
  }
  if (options.choices) {
    return `<div class="field"><label>${label}</label><select data-project="${key}">${options.choices.map((choice) => `<option ${choice === value ? "selected" : ""}>${choice}</option>`).join("")}</select></div>`;
  }
  return `<div class="field"><label>${label}</label><input data-project="${key}" value="${escapeAttr(value)}"></div>`;
}

function brandField(label, key) {
  return `<div class="field"><label>${label}</label><input data-brand="${key}" value="${escapeAttr(state.brandKit[key] ?? "")}"></div>`;
}

function brandTextarea(label, key) {
  return `<div class="field"><label>${label}</label><textarea data-brand="${key}">${escapeHtml(state.brandKit[key] ?? "")}</textarea></div>`;
}

function brandToggle(label, key) {
  return `<label class="toggle-row"><span>${label}</span><input type="checkbox" data-brand="${key}" ${state.brandKit[key] ? "checked" : ""}></label>`;
}

function leadField(label, key, options = {}) {
  const value = state.earlyAccessForm[key] ?? "";
  if (options.type === "textarea") {
    return `<div class="field"><label>${label}</label><textarea data-lead="${key}">${escapeHtml(value)}</textarea></div>`;
  }
  return `<div class="field"><label>${label}</label><input data-lead="${key}" value="${escapeAttr(value)}"></div>`;
}

function renderLayout(content) {
  const stepLabel = state.screen === "pricing" ? "Pricing" : screenToStep(state.screen) > 0 ? `Step ${screenToStep(state.screen)} of 5` : "AI reel studio";
  const navItems = [
    { screen: "upload", label: "Upload" },
    { screen: "template", label: "Style" },
    { screen: "processing", label: "AI" },
    { screen: "preview", label: "Preview" },
    { screen: "export", label: "Export" }
  ];
  app.innerHTML = `
    <main class="app">
      <aside class="side-nav">
        <div class="side-brand">
          <span>EM</span>
          <div>
            <strong>EstateMotion</strong>
            <small>AI listing media studio</small>
          </div>
        </div>
        <nav>
          ${navItems.map((item) => `<button class="${state.screen === item.screen ? "active" : ""}" data-nav="${item.screen}"><span>${item.label}</span><small>${navMicrocopy(item.screen)}</small></button>`).join("")}
        </nav>
        <div class="side-proof">
          <span>Positioning</span>
          <strong>Built for agents who sell status, speed, and story.</strong>
        </div>
      </aside>
      <header class="topbar">
        <div class="brand">
          <p>EstateMotion</p>
          <h1>${stepLabel}</h1>
        </div>
        <div class="top-progress" aria-label="Reel creation progress">
          ${navItems.map((item, index) => `<button class="${state.screen === item.screen ? "active" : ""} ${screenToStep(state.screen) > index + 1 ? "complete" : ""}" data-nav="${item.screen}"><span>${index + 1}</span><b>${item.label}</b></button>`).join("")}
        </div>
        <div class="top-actions">
          <span class="status-dot ${appModeClass()}">${appModeLabel()}</span>
          <span class="credit-pill">${state.user.creditBalance} credits</span>
          ${!featureFlags.MOCK_SUPABASE && authUser ? `<span class="status-dot live">Signed in</span><button class="reset-demo" data-sign-out>Sign out</button>` : ""}
          ${!featureFlags.MOCK_SUPABASE && !authUser ? `<button class="reset-demo auth-entry" data-auth-entry="sign-in">Sign in</button><button class="reset-demo auth-entry primary-lite" data-auth-entry="sign-up">Start free trial</button>` : ""}
          <button class="reset-demo" data-reset-demo>Reset demo</button>
        </div>
      </header>
      <section class="screen">
        ${localApiEnvWarning() ? `<div class="state-banner warning-state"><strong>Local env fallback</strong><span>${escapeHtml(localApiEnvWarning())}</span></div>` : ""}
        ${state.error ? `<div class="state-banner error-state"><strong>Needs attention</strong><span>${escapeHtml(state.error)}</span></div>` : ""}
        ${state.loading ? `<div class="state-banner loading-state"><span class="spinner"></span><strong>${escapeHtml(state.loading)}</strong></div>` : ""}
        ${content}
      </section>
      <nav class="bottom-nav">
        ${navItems.map((item) => `<button class="${state.screen === item.screen ? "active" : ""}" data-nav="${item.screen}">${item.label}</button>`).join("")}
      </nav>
      <div class="toast-stack">${state.toasts.map((toast) => `<div class="toast ${toast.type}">${escapeHtml(toast.message)}</div>`).join("")}</div>
    </main>
  `;
  document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.nav)));
  document.querySelector("[data-reset-demo]").addEventListener("click", resetDemoMode);
  document.querySelector("[data-sign-out]")?.addEventListener("click", signOut);
  document.querySelectorAll("[data-auth-entry]").forEach((button) => button.addEventListener("click", () => {
    setState({ authMode: button.dataset.authEntry, authReturnScreen: state.screen === "auth" ? state.authReturnScreen : state.screen, screen: "auth", error: "" });
  }));
  bindInputs();
}

function navMicrocopy(screen) {
  const labels = {
    upload: "Listing photos",
    template: "Video style",
    processing: "Build reel",
    preview: "Review reel",
    export: "Social assets"
  };
  return labels[screen] || "Workspace";
}

function bindInputs() {
  document.querySelectorAll("[data-project]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateProject(input.dataset.project, value, { quiet }));
  });
  document.querySelectorAll("[data-brand]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateBrand(input.dataset.brand, value, { quiet }));
  });
  document.querySelectorAll("[data-lead]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateEarlyAccess(input.dataset.lead, value, { quiet }));
  });
  document.querySelectorAll("[data-beta-feedback]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateBetaFeedback(input.dataset.betaFeedback, value, { quiet }));
  });
}

function bindAuthInputs() {
  document.querySelectorAll("[data-auth]").forEach((input) => {
    bindStableField(input, (value, quiet) => {
      const patch = { [input.dataset.auth]: value, error: "" };
      if (quiet) setStateQuietly(patch);
      else setState(patch);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      state.authMode === "sign-up" ? signUpWithPassword() : signInWithPassword();
    });
  });
}

function bindStableField(input, commit) {
  const readValue = () => input.type === "checkbox" ? input.checked : input.value;
  if (input.type === "checkbox" || input.tagName === "SELECT") {
    input.addEventListener("change", () => commit(readValue(), false));
    return;
  }
  input.addEventListener("input", () => commit(readValue(), true));
  input.addEventListener("blur", () => commit(readValue(), true));
}

function renderDashboard() {
  const photo = orderedPhotos()[0] ?? demoPhotos[0];
  renderLayout(`
    <section class="dashboard-command">
      <div class="dashboard-copy">
        <p class="eyebrow">EstateMotion AI reel studio</p>
        <h2>Your listings, elevated.</h2>
        <p>Look bigger. Move faster. Upload real listing photos and turn them into premium, MLS-safe marketing without fake property features.</p>
        <div class="brand-trust-row">
          ${["Built for modern agents", "Look bigger. Move faster.", "Your listings, elevated.", "No fake features. Real marketing."].map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
        <div class="actions">
          <button class="primary" data-action="continue">Upload Photos</button>
          <button class="secondary" data-action="sample">Try with sample listing</button>
          <button class="secondary" data-action="one-click">One-Click Reel</button>
          <button class="ghost" data-action="pro">Pro Mode</button>
        </div>
      </div>
      <div class="dashboard-reel-card">
        ${miniReelPreview(photo, "dashboard")}
      </div>
    </section>
    <section class="quick-flow panel elevated">
      ${quickStep("1", "Upload 8-15 listing photos", `${orderedPhotos().length} selected`)}
      ${quickStep("2", "Enter basic listing details", state.project.address ? "Saved" : "Needed")}
      ${quickStep("3", "Choose a reel style", selectedTemplate().name)}
      ${quickStep("4", "Review and edit your reel plan", state.project.reelPlanEdits ? "Edited" : "AI draft")}
      ${quickStep("5", "Export vertical MP4", featureFlags.MOCK_RENDERING ? "Mock/demo" : "Live render")}
    </section>
    <section class="panel os-command-center">
      <div class="section-title"><p>Marketing OS</p><h3>Choose the business outcome first.</h3></div>
      <div class="mode-grid premium-mode-grid">
        ${contentModes.slice(0, 8).map((mode) => `<button class="mode-card ${state.project.contentMode === mode.id ? "selected" : ""}" data-content-mode="${mode.id}">${state.project.contentMode === mode.id ? `<span class="recommend-badge">Recommended</span>` : ""}<strong>${escapeHtml(mode.name)}</strong><small>Best for ${escapeHtml(mode.bestFor)}</small></button>`).join("")}
      </div>
      <div class="recommendation-card"><strong>Recommended next move</strong><span>${escapeHtml(recommendationForCurrentAgent())}</span></div>
    </section>
    ${trustCopyPanel()}
  `);
  document.querySelector('[data-action="one-click"]').addEventListener("click", oneClickReel);
  document.querySelector('[data-action="sample"]').addEventListener("click", loadBetaSampleListing);
  document.querySelector('[data-action="continue"]').addEventListener("click", () => navigate("upload"));
  document.querySelector('[data-action="pro"]').addEventListener("click", () => navigate("details"));
  bindContentModeButtons();
}

function quickStep(number, title, value) {
  return `<article><span>${number}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(value)}</small></article>`;
}

function trustCopyPanel() {
  return `
    <section class="trust-copy-panel panel">
      ${["Uses your uploaded photos", "No fake property features", "MLS-safe captions", "Editable before export"].map((item) => `<article><span></span><strong>${escapeHtml(item)}</strong></article>`).join("")}
    </section>
  `;
}

function bindContentModeButtons() {
  document.querySelectorAll("[data-content-mode]").forEach((button) => {
    button.addEventListener("click", () => applyContentMode(button.dataset.contentMode));
  });
}

function applyContentMode(modeId) {
  const mode = contentModes.find((item) => item.id === modeId) || contentModes[0];
  setState((current) => ({
    ...current,
    selectedTemplateId: mode.template,
    project: {
      ...current.project,
      contentMode: mode.id,
      conversionGoal: mode.cta,
      cta: mode.cta,
      reelPlanEdits: null
    }
  }));
  trackEvent("content_mode_select", { contentMode: mode.id, templateId: mode.template });
  showToast(`${mode.name} mode selected`);
}

function miniReelPreview(photo, variant = "") {
  const copy = aiCopy();
  const theme = selectedReelTheme();
  return `
    <div class="mini-reel ${variant}" style="--reel-accent:${theme.accent}">
      <img src="${photo.uri}" alt="">
      <div class="mini-reel-shade"></div>
      <div class="mini-reel-top"><span>EstateMotion</span><b>9:16</b></div>
      <div class="mini-reel-copy">
        <strong>${escapeHtml(copy.hook)}</strong>
        <small>${escapeHtml(state.project.price)} / ${escapeHtml(state.project.city)} / ${escapeHtml(state.project.beds)} BD</small>
      </div>
      <div class="mini-reel-agent">${escapeHtml(state.brandKit.name)} / ${escapeHtml(state.brandKit.brokerage)}</div>
    </div>
  `;
}

function showcaseCard(project) {
  const active = state.selectedShowcaseId === project.id;
  return `
    <article class="showcase-card ${active ? "selected" : ""}">
      <img src="${project.thumbnail}" alt="">
      <div>
        <span>${escapeHtml(project.type)}</span>
        <strong>${escapeHtml(project.title)}</strong>
        <small>${escapeHtml(project.location)} - ${escapeHtml(project.price)}</small>
      </div>
      <p>${escapeHtml(project.themeLabel)} - ${project.project.photos.length} photos - ${project.project.reelVariations.length} variations</p>
      <button class="primary" data-showcase-id="${project.id}">Demo This Project</button>
    </article>
  `;
}

function comparisonCard(variation) {
  const theme = reelThemes.find((item) => item.id === variation.settings.reelTheme) ?? reelThemes[0];
  return `
    <article class="comparison-card" style="--comparison-accent:${theme.accent};--comparison-bg:${theme.background}">
      <span>${escapeHtml(variation.name)}</span>
      <strong>${escapeHtml(theme.name)}</strong>
      <small>${escapeHtml(variation.settings.textAnimation)} text - ${escapeHtml(variation.settings.musicMood)} music</small>
      <p>${escapeHtml(variation.hook)}</p>
    </article>
  `;
}

function renderDemoLanding() {
  trackDemoVisitOnce();
  renderLayout(`
    <section class="demo-hero panel elevated">
      <p class="eyebrow">Luxury AI video creation for modern agents</p>
      <h2>Turn listing photos into finished real estate reels in minutes.</h2>
      <p>Upload the property gallery. EstateMotion builds the sequence, hook, motion, captions, thumbnail, brand end card, and export pack so agents leave with content they can actually post.</p>
      <div class="actions">
        <button class="primary" data-nav="dashboard">Open product demo</button>
        <button class="secondary" data-scroll-leads>Request early access</button>
      </div>
    </section>
    <section class="outcome-flow">
      <article><span>01</span><strong>Upload photos</strong><small>Bring the existing listing gallery.</small></article>
      <article><span>02</span><strong>AI builds the reel</strong><small>Scene order, pacing, overlays, hook, and CTA.</small></article>
      <article><span>03</span><strong>Export social-ready content</strong><small>Reel, caption, hashtags, thumbnail, and content pack.</small></article>
    </section>
    <section class="luxury-metrics">
      ${metricCard("Launch assets", "5")}
      ${metricCard("Formats", "Reels / Stories / Shorts")}
      ${metricCard("Setup time", "Minutes")}
      ${metricCard("Brand control", "Agent + Brokerage")}
    </section>
    <section class="panel founder-story">
      <div class="section-title"><p>Founder thesis</p><h3>Built for agents becoming media brands.</h3></div>
      <p>Luxury listings already have the raw material: photography, architecture, neighborhood context, and agent trust. EstateMotion turns those ingredients into social-native campaigns without making the property look fake, cheap, or overproduced.</p>
    </section>
    <section class="panel transformation-section">
      <div class="section-title"><p>Before / after</p><h3>From static MLS gallery to launch campaign</h3></div>
      <div class="comparison-grid">
        <article class="comparison-card before-card"><span>Before</span><strong>25 photos sitting in a folder</strong><small>No hook, no pacing, no CTA, no personal brand lift.</small><p>Agents post late, inconsistently, or outsource simple listing content.</p></article>
        <article class="comparison-card"><span>After</span><strong>Premium content pack</strong><small>Full reel, highlights, story, caption, hashtags, and end card.</small><p>Every listing becomes a fast, polished social launch moment.</p></article>
        <article class="comparison-card pro-card"><span>Result</span><strong>More authority per listing</strong><small>Looks premium enough for sellers and native enough for buyers.</small><p>The agent is positioned as a marketer, not just a license holder.</p></article>
      </div>
    </section>
    <section class="panel">
      <div class="section-title"><p>How it works</p><h3>Outcome-first workflow</h3></div>
      <div class="steps-grid">
        <article><span>1</span><strong>Upload listing photos</strong><small>Use real MLS or photographer images from the property.</small></article>
        <article><span>2</span><strong>AI builds the reel</strong><small>EstateMotion creates scene order, pacing, hook, feature cards, and CTA.</small></article>
        <article><span>3</span><strong>Export reels, captions, and content packs</strong><small>Leave with launch assets for Reels, Stories, Shorts, and Instagram.</small></article>
      </div>
    </section>
    <section class="panel modern-agents">
      <div class="section-title"><p>Built for modern agents</p><h3>Status, speed, and repeatable content operations.</h3></div>
      <div class="steps-grid">
        <article><span>A</span><strong>Solo agents</strong><small>Look like a premium media team without hiring one.</small></article>
        <article><span>B</span><strong>Brokerages</strong><small>Standardize listing launch quality and compliance language.</small></article>
        <article><span>C</span><strong>Personal brands</strong><small>Turn every listing into proof of taste, authority, and market presence.</small></article>
      </div>
    </section>
    <section class="panel">
      <div class="section-title"><p>Pricing test</p><h3>What would agents pay?</h3></div>
      <div class="pricing-grid">
        ${pricingCard("Starter", "$19/export", "1 content pack", "For agents with occasional listings.", "Test price")}
        ${pricingCard("Pro", "$49/month", "Monthly content credits", "For agents posting every week.", "Test price")}
        ${pricingCard("Brokerage", "Custom", "Team workflow", "For offices that need compliance and brand control.", "Test price")}
      </div>
    </section>
    <section class="panel testimonials">
      <div class="section-title"><p>Early signal</p><h3>What brokerages should feel immediately</h3></div>
      <div class="steps-grid">
        <article><strong>"This makes us look faster and more expensive."</strong><small>Placeholder seller-facing brokerage reaction.</small></article>
        <article><strong>"I would use this for every listing launch."</strong><small>Placeholder agent validation quote.</small></article>
        <article><strong>"This solves the content bottleneck."</strong><small>Placeholder team lead reaction.</small></article>
      </div>
    </section>
    <section class="panel elevated" id="earlyAccess">
      <div class="section-title"><p>Request Early Access</p><h3>Founder call lead capture</h3></div>
      <div class="grid-2">${leadField("Name", "name")}${leadField("Email", "email")}</div>
      <div class="grid-2">${leadField("Brokerage", "brokerage")}${leadField("City", "city")}</div>
      ${leadField("Monthly listings", "monthlyListings")}
      ${leadField("Biggest content problem", "biggestProblem", { type: "textarea" })}
      <div class="actions">
        <button class="primary" data-submit-lead>Submit request</button>
        <button class="secondary" data-export-leads>Export CSV (${state.leads.length})</button>
      </div>
      ${state.leads.length ? `<div class="lead-list">${state.leads.slice(-3).reverse().map((lead) => `<article><strong>${escapeHtml(lead.name)}</strong><span>${escapeHtml(lead.email)} - ${escapeHtml(lead.city)}</span></article>`).join("")}</div>` : emptyState("No early-access requests yet", "Submissions are stored locally for founder validation.")}
    </section>
  `);
  document.querySelector("[data-scroll-leads]").addEventListener("click", () => document.querySelector("#earlyAccess").scrollIntoView({ behavior: "smooth" }));
  document.querySelector("[data-submit-lead]").addEventListener("click", submitLead);
  document.querySelector("[data-export-leads]").addEventListener("click", exportLeadsCsv);
  bindPricingTracking();
}

function renderDemoLandingPremium() {
  trackDemoVisitOnce();
  renderLayout(`
    <section class="landing-hero">
      <div class="landing-hero-copy">
        <p class="eyebrow">AI real estate media studio</p>
        <h2>Turn listing photos into finished real estate reels in minutes.</h2>
        <p>EstateMotion sorts rooms, adds cinematic camera motion, branding, music, captions, and exports every format.</p>
        <div class="actions">
          <button class="primary" data-nav="dashboard">Create My First Reel</button>
          <button class="secondary" data-scroll-proof>Watch Demo</button>
        </div>
        <div class="hero-proof-row">
          <span>No video footage needed</span>
          <span>Brand kit included</span>
          <span>MLS-ready exports</span>
        </div>
      </div>
      <div class="landing-device-stage">
        <div class="device-frame phone-main">${miniReelPreview(orderedPhotos()[0] ?? demoPhotos[0], "hero")}</div>
        <div class="device-frame phone-secondary">${miniReelPreview(orderedPhotos()[2] ?? demoPhotos[2], "hero-alt")}</div>
        <div class="device-caption"><strong>AI-built listing reel</strong><span>Motion / captions / brand / export</span></div>
      </div>
    </section>
    <section class="luxury-metrics">
      ${metricCard("Output", "Reel + pack")}
      ${metricCard("Setup", "Minutes")}
      ${metricCard("Formats", "9:16 / 1:1 / 16:9")}
      ${metricCard("Branding", "Agent + brokerage")}
    </section>
    <section class="landing-section split-showcase" id="proof">
      <div class="section-title"><p>Visual proof</p><h3>Before: listing photos. After: polished reel.</h3></div>
      <div class="transformation-grid">
        <article class="transform-card before">
          <span>Before</span>
          <strong>Listing photos</strong>
          <small>A gallery is useful, but it does not stop the scroll.</small>
          <div class="photo-stack">${demoPhotos.slice(0, 3).map((photo) => `<img src="${photo.uri}" alt="">`).join("")}</div>
        </article>
        <article class="transform-card after">
          <span>After</span>
          <strong>Polished reel</strong>
          <small>A finished, branded video built to post everywhere.</small>
          ${miniReelPreview(demoPhotos[0], "after")}
        </article>
      </div>
    </section>
    <section class="landing-section">
      <div class="section-title centered"><p>How it works</p><h3>Drop in photos. EstateMotion does the rest.</h3></div>
      <div class="landing-steps">
        <article><span>01</span><strong>Upload property photos</strong><small>Select the real listing images you already have.</small></article>
        <article><span>02</span><strong>EstateMotion creates the reel</strong><small>Rooms, motion, music, captions, and branding are assembled automatically.</small></article>
        <article><span>03</span><strong>Download MP4s, captions, thumbnails</strong><small>Leave with vertical reels, MLS versions, captions, and thumbnail assets.</small></article>
      </div>
    </section>
    <section class="landing-section template-landing">
      <div class="section-title centered"><p>Template previews</p><h3>Choose the reel style that fits the listing.</h3></div>
      <div class="template-showcase landing-template-showcase">
        ${templates.filter((template) => ["modern-luxury", "viral-fast-cut", "open-house", "mls-clean", "investor-wholesale"].includes(template.id)).map((template) => templateChoiceCard(template, simpleStyleName(template))).join("")}
      </div>
    </section>
    <section class="landing-section trust-section">
      <div class="section-title centered"><p>Built for agents</p><h3>Premium listing content without the production bottleneck.</h3></div>
      <div class="trust-feature-grid">
        <article><strong>Built for real estate agents</strong><small>Listing-first workflow, social-first output.</small></article>
        <article><strong>No videographer required</strong><small>Use the photos you already receive from the property shoot.</small></article>
        <article><strong>Brand kit included</strong><small>Add your headshot, brokerage, colors, and CTA.</small></article>
        <article><strong>MLS/compliance-ready exports</strong><small>Create branded and clean versions for different channels.</small></article>
      </div>
      <div class="testimonial-grid">
        <article><strong>"This feels like having a listing media team on demand."</strong><small>Agent testimonial placeholder</small></article>
        <article><strong>"The output is polished enough to show sellers."</strong><small>Brokerage testimonial placeholder</small></article>
        <article><strong>"I would use this every time a listing goes live."</strong><small>Team lead testimonial placeholder</small></article>
      </div>
    </section>
    <section class="landing-section pricing-landing">
      <div class="section-title centered"><p>Pricing</p><h3>Simple plans for listing launches.</h3></div>
      <div class="pricing-grid">
        ${pricingCard("Starter", "Pay per reel", "Single listing export", "For agents who want polished content one listing at a time.", "Start")}
        ${pricingCard("Pro", "Monthly", "Ongoing listing content", "For agents who launch listings and post every week.", "Most popular")}
        ${pricingCard("Brokerage", "Custom", "Team workflow", "For offices that need brand consistency and compliance-ready exports.", "Contact")}
      </div>
    </section>
    <section class="landing-section faq-section">
      <div class="section-title centered"><p>FAQ</p><h3>Simple answers for busy agents.</h3></div>
      <div class="faq-grid">
        ${faqItem("Do I need video footage?", "No. EstateMotion is designed to create polished reels from listing photos.")}
        ${faqItem("Can I use MLS photos?", "Yes, as long as you have the rights and permissions to use those photos in your marketing.")}
        ${faqItem("Does it export vertical reels?", "Yes. The product is built for Instagram Reels, TikTok, YouTube Shorts, and Stories.")}
        ${faqItem("Can I add my brokerage branding?", "Yes. Save your agent brand kit, brokerage details, CTA, and compliance language.")}
        ${faqItem("Is this AI-generated or based on real photos?", "It is based on real property photos with AI-assisted sorting, motion, captions, and formatting.")}
      </div>
    </section>
    <section class="landing-section early-access-panel elevated" id="earlyAccess">
      <div class="early-access-copy">
        <p class="eyebrow">Create your first listing reel</p>
        <h3>Ready to turn listing photos into finished content?</h3>
        <p>Request early access and test EstateMotion on your next listing launch.</p>
      </div>
      <div class="early-access-form">
        <div class="grid-2">${leadField("Name", "name")}${leadField("Email", "email")}</div>
        <div class="grid-2">${leadField("Brokerage", "brokerage")}${leadField("City", "city")}</div>
        ${leadField("Monthly listings", "monthlyListings")}
        ${leadField("Biggest content problem", "biggestProblem", { type: "textarea" })}
        <div class="actions">
          <button class="primary" data-submit-lead>Create your first listing reel</button>
          <button class="secondary" data-export-leads>Export CSV (${state.leads.length})</button>
        </div>
        ${state.leads.length ? `<div class="lead-list">${state.leads.slice(-3).reverse().map((lead) => `<article><strong>${escapeHtml(lead.name)}</strong><span>${escapeHtml(lead.email)} - ${escapeHtml(lead.city)}</span></article>`).join("")}</div>` : emptyState("No early-access requests yet", "Submissions are stored locally for founder validation.")}
      </div>
    </section>
  `);
  document.querySelector("[data-scroll-leads]")?.addEventListener("click", () => document.querySelector("#earlyAccess").scrollIntoView({ behavior: "smooth" }));
  document.querySelector("[data-scroll-proof]")?.addEventListener("click", () => document.querySelector("#proof").scrollIntoView({ behavior: "smooth" }));
  document.querySelector("[data-submit-lead]").addEventListener("click", submitLead);
  document.querySelector("[data-export-leads]").addEventListener("click", exportLeadsCsv);
  bindPricingTracking();
}

function renderBetaLanding() {
  trackDemoVisitOnce();
  renderLayout(`
    <section class="beta-hero landing-hero">
      <div class="landing-hero-copy">
        <p class="eyebrow">EstateMotion beta</p>
        <h2>Beta test the AI listing media OS built for real estate agents.</h2>
        <p>Upload listing photos, pick the business goal, review the reel plan, and export branded social assets your clients can actually understand.</p>
        <div class="actions">
          <button class="primary" data-beta-sample>Try sample listing</button>
          <button class="secondary" data-scroll-beta-signup>Join the beta</button>
        </div>
        <div class="hero-proof-row">
          <span>Uses your uploaded photos</span>
          <span>No fake property features</span>
          <span>MLS-safe captions</span>
        </div>
      </div>
      <div class="landing-device-stage">
        <div class="device-frame phone-main">${miniReelPreview(betaSampleListing.photos[0] ?? demoPhotos[0], "beta-hero")}</div>
        <div class="device-frame phone-secondary">${miniReelPreview(betaSampleListing.photos[2] ?? demoPhotos[2], "beta-alt")}</div>
        <div class="device-caption"><strong>Beta output</strong><span>Reel / caption / thumbnail / content pack</span></div>
      </div>
    </section>
    <section class="landing-section beta-audience">
      <div class="section-title centered"><p>Who it is for</p><h3>Agents and teams who need listing content without waiting on an editor.</h3></div>
      <div class="trust-feature-grid">
        <article><strong>Listing agents</strong><small>Turn every launch into a polished social campaign.</small></article>
        <article><strong>Brokerages</strong><small>Keep brand and compliance more consistent across agent content.</small></article>
        <article><strong>Investor-focused pros</strong><small>Create deal breakdowns, wholesale promos, and authority content.</small></article>
        <article><strong>Personal brands</strong><small>Look bigger, faster, and more credible online.</small></article>
      </div>
    </section>
    <section class="landing-section">
      <div class="section-title centered"><p>Beta onboarding</p><h3>Four steps. No production crew.</h3></div>
      <div class="landing-steps beta-steps">
        <article><span>01</span><strong>Upload 8-15 listing photos</strong><small>Use the real property photos already available for the listing.</small></article>
        <article><span>02</span><strong>Pick your goal</strong><small>Listing promo, seller lead, investor deal, neighborhood authority, or agent brand.</small></article>
        <article><span>03</span><strong>Review/edit reel</strong><small>Confirm scene order, captions, compliance, and branding before export.</small></article>
        <article><span>04</span><strong>Export and post</strong><small>Download MP4s, captions, hashtags, thumbnails, and content pack assets.</small></article>
      </div>
    </section>
    <section class="landing-section split-showcase">
      <div class="section-title"><p>Sample outputs</p><h3>One listing can become a full content package.</h3></div>
      <div class="template-showcase landing-template-showcase">
        ${[
          ["Listing Reel", "Full vertical tour from uploaded photos."],
          ["Seller Lead Magnet", "Your home could look like this online."],
          ["Investor Deal Breakdown", "Estimate-labeled ARV, rehab, and spread cards."],
          ["Neighborhood Spotlight", "Local authority content for city and area demand."]
        ].map(([title, body]) => `<article class="beta-output-card"><span>${escapeHtml(title)}</span><strong>${escapeHtml(body)}</strong>${miniReelPreview(betaSampleListing.photos[0] ?? demoPhotos[0], slug(title))}</article>`).join("")}
      </div>
    </section>
    <section class="landing-section trust-section">
      <div class="section-title centered"><p>Trust copy</p><h3>Built for real estate, not generic AI video.</h3></div>
      <div class="trust-feature-grid">
        <article><strong>Authentic listing visuals</strong><small>EstateMotion preserves uploaded-photo authenticity.</small></article>
        <article><strong>Editable before export</strong><small>Agents can correct captions, order, categories, and CTA.</small></article>
        <article><strong>Compliance-aware</strong><small>MLS clean mode, listing courtesy, brokerage disclaimer, and EHO support.</small></article>
        <article><strong>Outcome-focused</strong><small>Reels are built around showings, seller leads, investor interest, and authority.</small></article>
      </div>
    </section>
    <section class="landing-section beta-checklist-panel elevated">
      <div class="section-title"><p>Beta tester checklist</p><h3>What we want you to judge.</h3></div>
      <div class="beta-checklist">
        ${["Was the reel postable?", "Did the photos appear correctly?", "Were captions accurate?", "What would stop you from paying?"].map((item) => `<article><span></span><strong>${escapeHtml(item)}</strong></article>`).join("")}
      </div>
    </section>
    <section class="landing-section early-access-panel elevated" id="betaSignup">
      <div class="early-access-copy">
        <p class="eyebrow">Beta signup</p>
        <h3>Get early access and test a listing workflow.</h3>
        <p>Submissions are stored locally for now so founder-led validation stays simple.</p>
      </div>
      <div class="early-access-form">
        <div class="grid-2">${leadField("Name", "name")}${leadField("Email", "email")}</div>
        <div class="grid-2">${leadField("Brokerage", "brokerage")}${leadField("City", "city")}</div>
        ${leadField("Monthly listings", "monthlyListings")}
        ${leadField("Biggest content problem", "biggestProblem", { type: "textarea" })}
        <div class="actions">
          <button class="primary" data-submit-lead>Request beta access</button>
          <button class="secondary" data-beta-sample>Try sample listing</button>
          <button class="ghost" data-export-leads>Export CSV (${state.leads.length})</button>
        </div>
        ${state.leads.length ? `<div class="lead-list">${state.leads.slice(-3).reverse().map((lead) => `<article><strong>${escapeHtml(lead.name)}</strong><span>${escapeHtml(lead.email)} - ${escapeHtml(lead.city)}</span></article>`).join("")}</div>` : emptyState("No beta requests yet", "Beta signups will appear here locally.")}
      </div>
    </section>
  `);
  document.querySelectorAll("[data-beta-sample]").forEach((button) => button.addEventListener("click", () => {
    trackEvent("beta_try_sample_click", { path: window.location.pathname });
    loadBetaSampleListing();
  }));
  document.querySelector("[data-scroll-beta-signup]")?.addEventListener("click", () => document.querySelector("#betaSignup").scrollIntoView({ behavior: "smooth" }));
  document.querySelector("[data-submit-lead]").addEventListener("click", submitLead);
  document.querySelector("[data-export-leads]").addEventListener("click", exportLeadsCsv);
}

function faqItem(question, answer) {
  return `<article><strong>${escapeHtml(question)}</strong><p>${escapeHtml(answer)}</p></article>`;
}

function renderAuth() {
  const envError = supabaseEnvError();
  const isSignUp = state.authMode === "sign-up";
  const isExportGate = state.authReturnScreen === "export" || state.pendingExportAfterAuth;
  renderLayout(`
    <section class="auth-panel panel elevated ${isExportGate ? "auth-export-gate" : ""}">
      <p class="eyebrow">${isExportGate ? "Your video is ready" : "EstateMotion App"}</p>
      <h2>${isExportGate ? (isSignUp ? "Create your free account to export your video" : "Sign in to export your video") : (isSignUp ? "Create your account" : "Sign in to continue")}</h2>
      <p>${isExportGate ? "Create an account to save your project, render the final MP4, and keep your listing video exports connected to your brand kit." : "Sign in to save listing projects, brand kits, and finished video exports."}</p>
      ${isExportGate ? `<div class="auth-reassurance"><span>Your photos stay private</span><span>No credit card required</span><span>Save and export your finished video</span></div>` : ""}
      ${envError ? `<div class="state-banner error-state"><strong>Account setup unavailable</strong><span>Sign-in is not available in this environment yet. You can keep editing or try the sample video.</span></div>` : ""}
      <div class="auth-tabs">
        <button class="${!isSignUp ? "active" : ""}" data-auth-mode="sign-in">Sign In</button>
        <button class="${isSignUp ? "active" : ""}" data-auth-mode="sign-up">Create Account</button>
      </div>
      <div class="field">
        <label>Email</label>
        <input data-auth="authEmail" type="email" placeholder="agent@example.com" value="${escapeAttr(state.authEmail)}">
      </div>
      <div class="field">
        <label>Password</label>
        <input data-auth="authPassword" type="password" placeholder="${isSignUp ? "Create a password" : "Enter your password"}" value="${escapeAttr(state.authPassword)}">
      </div>
      <div class="actions">
        <button class="primary" data-auth-password ${envError ? "disabled" : ""}>${isSignUp ? (isExportGate ? "Create free account" : "Create Account") : "Sign In"}</button>
        <button class="secondary" data-auth-email ${envError ? "disabled" : ""}>Send magic link</button>
        <button class="secondary" data-auth-google ${envError ? "disabled" : ""}>Continue with Google</button>
        ${isExportGate ? `<button class="ghost" data-continue-editing>Continue editing</button>` : ""}
      </div>
      <p class="muted">${isSignUp ? "Already have an account?" : "New to EstateMotion?"} <button class="text-button" data-auth-mode="${isSignUp ? "sign-in" : "sign-up"}">${isSignUp ? "Sign in" : "Create account"}</button></p>
      ${state.authStatus === "email-sent" ? `<div class="state-banner loading-state"><strong>Magic link sent</strong><span>Open the link from your email to finish signing in.</span></div>` : ""}
    </section>
  `);
  document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => setState({ authMode: button.dataset.authMode, error: "" })));
  document.querySelector("[data-auth-password]").addEventListener("click", () => state.authMode === "sign-up" ? signUpWithPassword() : signInWithPassword());
  document.querySelector("[data-auth-email]").addEventListener("click", signInWithMagicLink);
  document.querySelector("[data-auth-google]").addEventListener("click", signInWithGoogle);
  document.querySelector("[data-continue-editing]")?.addEventListener("click", () => setState({ screen: "preview", pendingExportAfterAuth: false, authReturnScreen: "dashboard", error: "" }));
  bindAuthInputs();
}

function trackDemoVisitOnce() {
  const key = `estatemotion.demo.visit.${window.location.pathname}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "true");
  trackEvent("demo_visit", { path: window.location.pathname || "/demo" });
}

function renderOnboarding() {
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Agent onboarding</p><h2>Build the brand layer once.</h2><p>These details turn every listing into a polished, personal-brand media asset with brokerage trust built in.</p></div>
    <section class="panel elevated">
      <div class="grid-2">${brandField("Name", "name")}${brandField("Brokerage", "brokerage")}</div>
      <div class="grid-2">${brandField("Headshot URL", "headshotUri")}${brandField("Logo URL", "logoUri")}</div>
      <div class="grid-2">
        <div class="field"><label>Upload headshot</label><input type="file" accept="image/*" data-brand-upload="headshot"></div>
        <div class="field"><label>Upload logo</label><input type="file" accept="image/*" data-brand-upload="logo"></div>
      </div>
      <div class="grid-2">${brandField("Phone", "phone")}${brandField("Website", "website")}</div>
      <div class="grid-2">${brandField("Email", "email")}${brandField("Instagram", "instagram")}</div>
      ${brandField("CTA text", "ctaText")}
      <button class="primary" data-finish-onboarding>Start dashboard</button>
    </section>
  `);
  document.querySelector("[data-finish-onboarding]").addEventListener("click", () => guard(validateBrandKit(), () => {
    setState({ hasOnboarded: true, screen: "dashboard", error: "" });
    showToast("Brand kit saved");
  }));
  bindBrandUploads();
}

function renderCreate() {
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Quick setup</p><h2>Tell EstateMotion what this listing is.</h2><p>Only the basics are needed to build a social-ready reel. Extra controls stay tucked away for power users.</p></div>
    <section class="panel quick-project-panel">
      <div class="grid-2">${field("Property address", "address")}${field("Price", "price")}</div>
      <div class="grid-2">${field("City", "city")}${field("Listing type", "listingType", { choices: ["Just Listed", "Open House", "Price Drop", "Coming Soon", "Sold", "For Rent"] })}</div>
      <details class="advanced-panel">
        <summary>Advanced listing details</summary>
        ${field("Property title", "title")}
        <div class="grid-2">${field("Neighborhood", "neighborhood")}${field("Square footage", "squareFeet")}</div>
        <div class="grid-2">${field("Beds", "beds")}${field("Baths", "baths")}</div>
        <div class="mode-grid">
          <label class="toggle-row"><span>Authenticity Mode</span><input type="checkbox" data-project="authenticityMode" ${state.project.authenticityMode ? "checked" : ""}></label>
          <label class="toggle-row"><span>Local Agent Mode</span><input type="checkbox" data-project="localAgentMode" ${state.project.localAgentMode ? "checked" : ""}></label>
        </div>
      </details>
      <button class="primary" data-next="upload">Continue to upload</button>
    </section>
  `);
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics(), () => {
    showToast("Project details saved");
    navigate("upload");
  }));
}

function renderUpload() {
  const photos = orderedPhotos();
  const needsLiveAuth = !featureFlags.MOCK_SUPABASE && !authUser && !isDemoRoute();
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Upload photos</p><h2>Drop in the listing gallery.</h2><p>EstateMotion handles the scene order, pacing, hook, Top 3 Features, and CTA. Pro controls are still here when you want them.</p></div>
    ${trustCopyPanel()}
    ${needsLiveAuth ? `<section class="panel sign-in-required-card"><div><p class="eyebrow">Sign in required</p><h3>Sign in to upload and persist listing photos.</h3><p class="muted">Live Supabase mode stores photos in durable Storage URLs for Remotion rendering.</p></div><button class="primary" data-auth-entry-upload>Sign In</button></section>` : ""}
    ${classificationModeBanner()}
    <section class="upload-studio-card">
      <label class="upload-zone" data-upload-zone>
        <input id="photoInput" type="file" accept="image/*" multiple>
        <span class="upload-plus">+</span>
        <strong>Upload 8-15 listing photos</strong>
        <span class="muted">Drag and drop JPG, PNG, or WebP images here. Use Select All from Folder in the file picker.</span>
        <b class="upload-count">${photos.length} photo${photos.length === 1 ? "" : "s"} uploaded</b>
      </label>
      <aside class="upload-status-card">
        <span>Upload status</span>
        <strong>${photos.length >= 3 ? "Ready for style selection" : "Need at least 3 photos"}</strong>
        <small>${featureFlags.MOCK_SUPABASE ? "Mock Mode uses local previews." : authUser ? "Supabase durable upload enabled." : "Sign in to persist photos."}</small>
      </aside>
    </section>
    <section class="panel listing-basics-panel">
      <div class="section-title"><p>Listing basics</p><h3>Only what the reel needs</h3></div>
      <div class="grid-2">${field("Property address", "address")}${field("Price", "price")}</div>
      <div class="grid-2">${field("Beds", "beds")}${field("Baths", "baths")}</div>
      <div class="grid-2">${field("Square footage", "squareFeet")}${field("City / neighborhood", "city")}</div>
      <div class="grid-2">${brandField("Agent name", "name")}${brandField("Brokerage/team", "brokerage")}</div>
      <div class="grid-2">${brandField("Phone", "phone")}${brandField("Email", "email")}</div>
    </section>
    <div class="actions">
      <button class="secondary" data-add-more type="button">Add More Photos</button>
      <button class="secondary" data-sample-listing type="button">Try with sample listing</button>
      <button class="ghost" data-demo>Add demo photos</button>
      <button class="primary" data-next="template">Choose Style</button>
    </div>
    <details class="advanced-panel">
      <summary>Pro Controls: scene intelligence and manual order</summary>
      <section class="panel engine-panel">
        <div class="section-title"><p>Reel-E style workflow engine</p><h3>Smart scene intelligence</h3></div>
        <div class="engine-grid">
          ${engineMetric("Avg confidence", `${averageConfidence(photos)}%`)}
          ${engineMetric("Scene types found", new Set(photos.map((photo) => sceneLabel(photo.category))).size || 0)}
          ${engineMetric("Motion system", selectedMotionSystem().tempo)}
          ${engineMetric("Render-ready scenes", photos.length)}
        </div>
        <p class="muted">Magic Sort uses filename, order, and real estate scene logic to suggest a listing flow. Manual overrides stay available for accuracy.</p>
        <div class="actions">
          <button class="secondary" data-featured-flow>Best Listing Flow</button>
          <button class="secondary" data-sort>Magic Sort Intelligence</button>
        </div>
      </section>
    </details>
    <section class="photo-grid">
      ${photos.length ? photos.map((photo, index) => photoCard(photo, index)).join("") : emptyState("No photos selected", "Choose listing photos or add demo photos to continue.")}
    </section>
  `);
  const input = document.querySelector("#photoInput");
  input.addEventListener("change", handlePhotoFiles);
  document.querySelector("[data-add-more]").addEventListener("click", () => input.click());
  document.querySelector("[data-auth-entry-upload]")?.addEventListener("click", () => setState({ authMode: "sign-in", authReturnScreen: "upload", screen: "auth", error: "" }));
  bindUploadDropZone();
  document.querySelector("[data-sample-listing]").addEventListener("click", loadBetaSampleListing);
  document.querySelector("[data-sort]")?.addEventListener("click", sortPhotos);
  document.querySelector("[data-featured-flow]")?.addEventListener("click", applyFeaturedPropertyFlow);
  document.querySelector("[data-demo]").addEventListener("click", () => {
    setState((current) => ({ ...current, error: "", project: { ...current.project, photos: demoPhotos } }));
    showToast("Demo photos loaded");
  });
  document.querySelector("[data-next]").addEventListener("click", () => guard(validatePhotos(), () => navigate("template")));
  bindPhotoControls();
}

function classificationModeBanner() {
  if (featureFlags.MOCK_AI) {
    return `<div class="state-banner warning-state"><strong>Fallback classification active</strong><span>MOCK_AI=true, so EstateMotion will not call /api/classify-image. Filename/order heuristics are used until OpenAI Vision is enabled server-side.</span></div>`;
  }
  return `<div class="state-banner loading-state"><strong>AI Vision enabled</strong><span>EstateMotion will try /api/classify-image after upload and fall back safely if OPENAI_API_KEY or the Vision API is unavailable.</span></div>`;
}

function averageConfidence(photos) {
  if (!photos.length) return 0;
  return Math.round(photos.reduce((sum, photo) => sum + sceneConfidence(photo), 0) / photos.length);
}

function engineMetric(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function photoCard(photo, index) {
  const confidence = sceneConfidence(photo);
  const suggestions = sceneSuggestions(photo).filter((item) => item !== sceneLabel(photo.category)).slice(0, 2);
  const features = (photo.visibleFeatures || photo.tags || []).slice(0, 3);
  const source = photo.classificationSource === "openai-vision" ? "AI Vision" : photo.classificationSource === "manual" ? "Manual" : "Fallback";
  return `
    <article class="photo-card" draggable="true" data-photo-id="${photo.id}">
      <div class="photo-thumb"><img src="${photo.uri}" alt=""></div>
      <div class="photo-meta"><span>${index + 1}. ${escapeHtml(sceneLabel(photo.category))}</span><span>${escapeHtml(photo.fileName)}</span></div>
      <div class="confidence-row"><span>${confidence}% confidence</span><b class="source-badge ${escapeAttr(photo.classificationSource || "fallback")}">${escapeHtml(source)}</b></div>
      ${photo.description ? `<p class="vision-description">${escapeHtml(photo.description)}</p>` : ""}
      ${features.length ? `<div class="feature-pills">${features.map((feature) => `<span>${escapeHtml(feature)}</span>`).join("")}</div>` : ""}
      ${photo.fallbackReason ? `<p class="vision-fallback">${escapeHtml(photo.fallbackReason)}</p>` : ""}
      ${suggestions.length ? `<div class="suggestion-row"><span>Suggested:</span>${suggestions.map((suggestion) => `<button data-suggest-photo="${photo.id}" data-suggest-category="${escapeAttr(suggestion)}">${escapeHtml(suggestion)}</button>`).join("")}</div>` : ""}
      <label class="photo-type-select">
        <span>Scene type</span>
        <select data-photo-type="${photo.id}">
          ${sceneTypes.map((type) => `<option value="${type}" ${sceneLabel(photo.category) === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </label>
      <div class="photo-controls">
        <button data-move="${photo.id}" data-dir="-1">Up</button>
        <button data-move="${photo.id}" data-dir="1">Down</button>
        <button data-remove="${photo.id}">Remove</button>
      </div>
    </article>
  `;
}

async function handlePhotoFiles(event) {
  await processSelectedFiles([...event.target.files]);
  event.target.value = "";
}

async function processSelectedFiles(selectedFiles) {
  const ingestion = window.EstateMotionReel?.photoIngestion;
  const validated = ingestion?.validateImageFiles ? ingestion.validateImageFiles(selectedFiles) : {
    imageFiles: selectedFiles.filter((file) => file.type.startsWith("image/")),
    rejectedFiles: selectedFiles.filter((file) => !file.type.startsWith("image/"))
  };
  const imageFiles = validated.imageFiles;
  const rejectedCount = validated.rejectedFiles.length;
  if (rejectedCount) {
    const firstReason = validated.rejectedFiles[0]?.reason || "Unsupported image format.";
    showToast(`${rejectedCount} file${rejectedCount === 1 ? "" : "s"} skipped: ${firstReason}`, "error");
  }
  if (!imageFiles.length) {
    setError("No image files were selected. Upload JPG, PNG, or WebP photos.");
    return;
  }
  const currentPhotos = orderedPhotos();
  const existingKeys = new Set(currentPhotos.map(photoDuplicateKey));
  const uniqueFiles = [];
  let duplicateCount = 0;
  imageFiles.forEach((file) => {
    const key = fileDuplicateKey(file);
    if (existingKeys.has(key)) {
      duplicateCount += 1;
      return;
    }
    existingKeys.add(key);
    uniqueFiles.push(file);
  });
  if (duplicateCount) {
    showToast(`${duplicateCount} duplicate photo${duplicateCount === 1 ? "" : "s"} skipped`, "error");
  }
  if (!uniqueFiles.length) {
    setError("Those photos are already in this project.");
    return;
  }
  const shouldUploadDurablyNow = !featureFlags.MOCK_SUPABASE && Boolean(authUser) && !isDemoRoute();
  setState({ loading: shouldUploadDurablyNow ? "Uploading photos to Supabase Storage..." : "Preparing local preview photos...", error: "" });
  try {
    const remoteProjectId = shouldUploadDurablyNow ? await ensureRemoteProjectForUploads() : "";
    const uploadedAssets = await Promise.all(uniqueFiles.map(async (file, index) => {
      const asset = await prepareProjectPhoto(file, index, remoteProjectId);
      if (shouldUploadDurablyNow && !asset?.durableUrl) {
        throw new Error(`${file.name} uploaded but did not return a durable render URL. Check the ${featureFlags.LISTING_PHOTOS_BUCKET} Supabase bucket permissions or signed URL policy.`);
      }
      return asset;
    }));
    const uploadedPhotos = await Promise.all(uniqueFiles.map(async (file, index) => {
      const classification = classifyPhoto(file.name, currentPhotos.length + index);
      const publicUrl = uploadedAssets[index].publicUrl || uploadedAssets[index].durableUrl || uploadedAssets[index].previewUrl;
      const basePhoto = ingestion?.normalizeUploadedPhoto
        ? await ingestion.normalizeUploadedPhoto({ file, asset: uploadedAssets[index], id: `local-${Date.now()}-${index}`, uploadOrder: currentPhotos.length + index })
        : {
          id: `local-${Date.now()}-${index}`,
          uri: publicUrl,
          publicUrl,
          public_url: publicUrl,
          durableUrl: uploadedAssets[index].durableUrl || "",
          durable_url: uploadedAssets[index].durableUrl || "",
          durableUrlExpiresAt: uploadedAssets[index].durableUrlExpiresAt || "",
          bucket: uploadedAssets[index].bucket || "",
          storagePath: uploadedAssets[index].path,
          fileName: file.name,
          size: file.size,
          uploadOrder: currentPhotos.length + index
        };
      return {
        ...basePhoto,
        category: classification.category,
        pipelineCategory: classification.pipelineCategory,
        confidence: classification.confidence,
        tags: classification.tags || [],
        visibleFeatures: classification.visibleFeatures || classification.tags || [],
        description: classification.description || "",
        classificationSource: classification.classificationSource || "fallback",
        fallbackReason: classification.fallbackReason || "",
        durableUrl: basePhoto.durableUrl || uploadedAssets[index].durableUrl || "",
        durable_url: basePhoto.durable_url || uploadedAssets[index].durableUrl || "",
        durableUrlExpiresAt: basePhoto.durableUrlExpiresAt || uploadedAssets[index].durableUrlExpiresAt || "",
        bucket: basePhoto.bucket || uploadedAssets[index].bucket || featureFlags.LISTING_PHOTOS_BUCKET,
        suggestedCorrections: classification.suggestedCorrections,
        reelScore: window.EstateMotionReel?.photoRanker?.scorePhoto ? window.EstateMotionReel.photoRanker.scorePhoto({ ...basePhoto, classification }) : 0,
        order: currentPhotos.length + index + 1
      };
    }));
    uploadedPhotos.forEach((photo, index) => {
      if (!uploadedAssets[index].durableUrl) temporaryPhotoFiles.set(photo.id, uniqueFiles[index]);
    });
    setState((current) => {
      const existing = [...current.project.photos].sort((a, b) => a.order - b.order);
      const photos = [...existing, ...uploadedPhotos].map((photo, index) => ({ ...photo, localOnly: !photo.durableUrl && !photo.durable_url, order: index + 1 }));
      return {
        ...current,
        loading: "",
        error: "",
        project: {
          ...current.project,
          motionDirectorPlan: null,
          reelPlanEdits: null,
          motionDirectorStatus: motionDirectorIdleStatus(current.project.motionDirectorStatus),
          photos
        }
      };
    });
    const total = currentPhotos.length + uploadedPhotos.length;
    showToast(`${total} photo${total === 1 ? "" : "s"} uploaded`);
    await enhanceUploadedPhotosWithVision(uploadedPhotos);
  } catch (error) {
    setError(error.message || "Photo upload failed. Try smaller image files.");
  }
}

async function enhanceUploadedPhotosWithVision(uploadedPhotos) {
  if (featureFlags.MOCK_AI || !uploadedPhotos.length || !window.EstateMotionReel?.imageClassifier?.classifyPhotoWithVision) return;
  if (uploadedPhotos.some((photo) => isLocalOnlyUrl(photo.durableUrl || photo.durable_url || photo.uri))) {
    showToast("Vision unavailable before account creation; fallback classification used.", "error");
    return;
  }
  try {
    setState({ loading: "Analyzing photos with OpenAI Vision...", error: "" });
    const enhanced = [];
    for (const photo of uploadedPhotos) {
      const result = await window.EstateMotionReel.imageClassifier.classifyPhotoWithVision(photo, {
        endpoint: featureFlags.VISION_CLASSIFICATION_ENDPOINT,
        lowConfidenceThreshold: 62
      });
      enhanced.push({ id: photo.id, classification: normalizeClassification(result) });
    }
    const enhancedById = new Map(enhanced.map((item) => [item.id, item.classification]));
    const usedVision = enhanced.some((item) => item.classification.classificationSource === "openai-vision");
    setState((current) => ({
      ...current,
      loading: "",
      project: {
        ...current.project,
        photos: current.project.photos.map((photo) => {
          const classification = enhancedById.get(photo.id);
          if (!classification || classification.classificationSource !== "openai-vision") {
            return classification ? { ...photo, fallbackReason: classification.fallbackReason || photo.fallbackReason } : photo;
          }
          return {
            ...photo,
            category: classification.category,
            pipelineCategory: classification.pipelineCategory,
            confidence: classification.confidence,
            tags: classification.tags || [],
            visibleFeatures: classification.visibleFeatures || [],
            description: classification.description || "",
            classificationSource: classification.classificationSource,
            fallbackReason: "",
            suggestedCorrections: classification.suggestedCorrections || []
          };
        })
      }
    }));
    const fallbackReason = enhanced.find((item) => item.classification.fallbackReason)?.classification.fallbackReason || "OPENAI_API_KEY may be missing or the Vision endpoint is unavailable.";
    showToast(usedVision ? "OpenAI Vision classification applied" : `Vision unavailable; fallback used. ${fallbackReason}`, usedVision ? "success" : "error");
  } catch (error) {
    setState({ loading: "" });
    showToast(`Vision unavailable; fallback classification used. ${error.message || "Check OPENAI_API_KEY and /api/classify-image."}`, "error");
  }
}

async function ensureRemoteProjectForUploads() {
  if (!authUser) throw new Error("Sign in before uploading photos to Supabase Storage.");
  const ids = await window.EstateMotionSupabase.saveWorkspace(state, authUser);
  if (ids.projectId && state.project.id !== ids.projectId) {
    state = { ...state, project: { ...state.project, id: ids.projectId } };
  }
  if (ids.brandKitId && state.brandKit.id !== ids.brandKitId) {
    state = { ...state, brandKit: { ...state.brandKit, id: ids.brandKitId } };
  }
  if (ids.warnings?.length) {
    showToast(ids.warnings[0], "error");
  }
  if (!ids.projectId && !state.project.id) {
    throw new Error("Project sync did not return a Supabase project id. Run the live schema migration, then try uploading again.");
  }
  return ids.projectId || state.project.id;
}

async function persistTemporaryPhotosAfterAuth() {
  if (featureFlags.MOCK_SUPABASE || !authUser || isDemoRoute()) return;
  const photos = orderedPhotos();
  const needsUpload = photos.filter((photo) => !photo.durableUrl && !photo.durable_url);
  if (!needsUpload.length) return;
  const remoteProjectId = await ensureRemoteProjectForUploads();
  const uploaded = [];
  for (let index = 0; index < needsUpload.length; index += 1) {
    const photo = needsUpload[index];
    if (!isLocalOnlyUrl(photo.uri || photo.objectUrl)) {
      uploaded.push({
        id: photo.id,
        durableUrl: photo.uri || photo.publicUrl || photo.public_url,
        publicUrl: photo.uri || photo.publicUrl || photo.public_url,
        public_url: photo.uri || photo.publicUrl || photo.public_url,
        durable_url: photo.uri || photo.publicUrl || photo.public_url,
        localOnly: false
      });
      continue;
    }
    const file = temporaryPhotoFiles.get(photo.id);
    if (!file) {
      throw new Error(`Re-select ${photo.fileName || "the local photo"} to save it for final MP4 export. Browser preview URLs cannot be uploaded after a page refresh.`);
    }
    const asset = await prepareProjectPhoto(file, index, remoteProjectId);
    if (!asset.durableUrl) throw new Error(`${photo.fileName || file.name} did not return a durable Supabase URL.`);
    uploaded.push({
      id: photo.id,
      uri: asset.publicUrl || asset.durableUrl,
      publicUrl: asset.publicUrl || "",
      public_url: asset.publicUrl || "",
      durableUrl: asset.durableUrl,
      durable_url: asset.durableUrl,
      durableUrlExpiresAt: asset.durableUrlExpiresAt || "",
      bucket: asset.bucket || featureFlags.LISTING_PHOTOS_BUCKET,
      storagePath: asset.path || "",
      localOnly: false
    });
  }
  const byId = new Map(uploaded.map((photo) => [photo.id, photo]));
  state = {
    ...state,
    project: {
      ...state.project,
      photos: state.project.photos.map((photo) => byId.has(photo.id) ? { ...photo, ...byId.get(photo.id) } : photo)
    }
  };
  saveState();
}

async function prepareProjectPhoto(file, index, remoteProjectId = "") {
  if (featureFlags.MOCK_SUPABASE || isDemoRoute() || !authUser) {
    const objectUrl = URL.createObjectURL(file);
    return { previewUrl: objectUrl, objectUrl, publicUrl: "", durableUrl: "", path: "", bucket: "", localOnly: true };
  }
  if (!authUser) throw new Error("Sign in before uploading photos to Supabase Storage.");
  const projectId = remoteProjectId || state.project.id || "draft";
  const path = `${authUser.id}/projects/${projectId}/${Date.now()}-${index}-${file.name}`;
  if (!window.EstateMotionSupabase?.uploadListingPhoto) throw new Error("Supabase upload helper is unavailable. Set MOCK_SUPABASE=true for local demo mode.");
  return uploadWithRetry(() => window.EstateMotionSupabase.uploadListingPhoto(file, path), file.name);
}

async function uploadWithRetry(operation, fileName, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      showToast(`Upload retry ${attempt + 1} for ${fileName}`, "error");
      await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
    }
  }
  throw new Error(`${fileName} failed to upload to Supabase Storage. ${lastError?.message || "Try again or switch to mock mode for local demos."}`);
}

function fileDuplicateKey(file) {
  return `${file.name.toLowerCase()}::${file.size}`;
}

function photoDuplicateKey(photo) {
  return `${String(photo.fileName ?? "").toLowerCase()}::${photo.size ?? 0}`;
}

function bindUploadDropZone() {
  const zone = document.querySelector("[data-upload-zone]");
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("drag-over");
    processSelectedFiles([...event.dataTransfer.files]);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function bindBrandUploads() {
  document.querySelectorAll("[data-brand-upload]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("Brand assets must be image files.");
        return;
      }
      const type = input.dataset.brandUpload;
      setState({ loading: shouldUseLocalPersistence() ? "Preparing brand asset..." : "Uploading brand asset...", error: "" });
      try {
        const asset = shouldUseLocalPersistence()
          ? { publicUrl: await readFileAsDataUrl(file), path: "" }
          : await window.EstateMotionSupabase.uploadAsset(file, window.EstateMotionSupabase.buckets.brandAssets, `${authUser.id}/brand/${Date.now()}-${type}-${file.name}`);
        setState((current) => ({
          ...current,
          loading: "",
          brandKit: {
            ...current.brandKit,
            [type === "headshot" ? "headshotUri" : "logoUri"]: asset.publicUrl,
            [type === "headshot" ? "headshotPath" : "logoPath"]: asset.path
          }
        }));
        showToast(`${type === "headshot" ? "Headshot" : "Logo"} uploaded`);
      } catch (error) {
        setError(error.message || "Brand asset upload failed.");
      } finally {
        input.value = "";
      }
    });
  });
}

function bindPhotoControls() {
  bindPhotoDragReorder();
  document.querySelectorAll("[data-photo-type]").forEach((select) => {
    select.addEventListener("change", () => updatePhotoType(select.dataset.photoType, select.value));
  });
  document.querySelectorAll("[data-move]").forEach((button) => {
    button.addEventListener("click", () => movePhoto(button.dataset.move, Number(button.dataset.dir)));
  });
  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const photos = orderedPhotos().filter((photo) => photo.id !== button.dataset.remove).map((photo, index) => ({ ...photo, order: index + 1 }));
      setState((current) => ({ ...current, project: { ...current.project, photos } }));
    });
  });
  document.querySelectorAll("[data-suggest-photo]").forEach((button) => {
    button.addEventListener("click", () => updatePhotoType(button.dataset.suggestPhoto, button.dataset.suggestCategory));
  });
}

function updatePhotoType(id, category) {
  const photos = orderedPhotos().map((photo) => photo.id === id ? {
    ...photo,
    category,
    pipelineCategory: sceneToPipelineCategory(category),
    confidence: 100,
    classificationSource: "manual",
    fallbackReason: "",
    suggestedCorrections: []
  } : photo);
  setState((current) => ({ ...current, project: { ...current.project, photos } }));
  showToast("Photo scene type updated");
}

function bindPhotoDragReorder() {
  document.querySelectorAll("[data-photo-id]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", card.dataset.photoId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      card.classList.add("drop-target");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("drop-target");
      const draggedId = event.dataTransfer.getData("text/plain");
      reorderPhotoBefore(draggedId, card.dataset.photoId);
    });
  });
}

function reorderPhotoBefore(draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const photos = orderedPhotos();
  const dragged = photos.find((photo) => photo.id === draggedId);
  if (!dragged) return;
  const remaining = photos.filter((photo) => photo.id !== draggedId);
  const targetIndex = remaining.findIndex((photo) => photo.id === targetId);
  remaining.splice(targetIndex, 0, dragged);
  setState((current) => ({ ...current, project: { ...current.project, photos: remaining.map((photo, order) => ({ ...photo, order: order + 1 })) } }));
  showToast("Photo order updated");
}

function movePhoto(id, direction) {
  const photos = orderedPhotos();
  const index = photos.findIndex((photo) => photo.id === id);
  const target = index + direction;
  if (target < 0 || target >= photos.length) return;
  [photos[index], photos[target]] = [photos[target], photos[index]];
  setState((current) => ({ ...current, project: { ...current.project, photos: photos.map((photo, order) => ({ ...photo, order: order + 1 })) } }));
}

function sortPhotos() {
  const planned = createPipelineSequence().scenes.map((scene) => scene.photo);
  const fallback = [...state.project.photos].sort((a, b) => flowRank(sceneLabel(a.category)) - flowRank(sceneLabel(b.category)) || sceneConfidence(b) - sceneConfidence(a) || a.order - b.order);
  const source = planned.length ? planned : fallback;
  const photos = source.map((photo, index) => ({ ...photo, order: index + 1 }));
  setState((current) => ({ ...current, project: { ...current.project, photos } }));
  showToast("Photos sorted for a real estate reel");
}

function applyFeaturedPropertyFlow() {
  const ordered = createPipelineSequence().scenes.map((scene) => scene.photo);
  const photos = ordered.length ? ordered : orderedPhotos();
  setState((current) => ({ ...current, project: { ...current.project, photos: photos.map((photo, order) => ({ ...photo, order: order + 1 })) } }));
  showToast("Best Listing Flow applied");
}

function oneClickReel() {
  const photoError = validatePhotos();
  if (photoError) {
    setError("Upload at least 3 listing photos before using One-Click Reel.");
    navigate("upload");
    return;
  }

  const ordered = [...state.project.photos]
    .sort((a, b) => flowRank(sceneLabel(a.category)) - flowRank(sceneLabel(b.category)) || sceneConfidence(b) - sceneConfidence(a) || a.order - b.order)
    .map((photo, index) => ({ ...photo, order: index + 1 }));
  const city = state.project.city || "your market";
  const templateId = state.project.listingType === "Open House"
    ? "open-house"
    : state.project.captionTone === "Viral"
      ? "viral-fast-cut"
      : state.project.localAgentMode && /scottsdale/i.test(city)
        ? "desert-luxury"
        : "modern-luxury";
  const template = templates.find((item) => item.id === templateId) ?? templates[0];
  const preset = state.project.listingType === "Open House" ? "Open House" : templateId === "viral-fast-cut" ? "Just Listed" : templateId === "desert-luxury" ? "Scottsdale Luxury" : "Luxury";
  const hook = window.EstateMotionReel?.copyGenerator?.generateHook
    ? window.EstateMotionReel.copyGenerator.generateHook(pipelineListingDetails(), templatePipelineId())
    : hydratePreset(hookPresets[preset] || hookPresets.Luxury);
  const cta = window.EstateMotionReel?.copyGenerator?.generateCTA
    ? window.EstateMotionReel.copyGenerator.generateCTA(pipelineListingDetails())
    : currentProjectCta(template);

  setState((current) => ({
    ...current,
    selectedTemplateId: template.id,
    selectedScene: 0,
    screen: "processing",
    error: "",
    project: {
      ...current.project,
      photos: ordered,
      hookPreset: preset,
      hookText: hook,
      cta,
      thumbnailPreset: templateId === "viral-fast-cut" ? "Inside This Home" : current.project.thumbnailPreset,
      reelTheme: templateId === "desert-luxury" ? "scottsdale-desert-luxury" : templateId === "open-house" ? "open-house-fast-cut" : current.project.reelTheme,
      reelVariations: createReelVariations()
    }
  }));
  trackEvent("one_click_reel", { templateId: template.id, photos: ordered.length });
  showToast("AI reel build started");
}

function currentProjectCta(template) {
  return state.project.cta || template?.ctaWording || state.brandKit.ctaText || "Schedule your private tour";
}

function flowRank(category) {
  const normalized = sceneLabel(category);
  const index = featuredPropertyFlow.findIndex((item) => sceneLabel(item) === normalized || item === normalized);
  return index === -1 ? 999 : index;
}

function pipelineListingDetails() {
  return {
    address: state.project.address,
    price: state.project.price,
    beds: state.project.beds,
    baths: state.project.baths,
    squareFeet: state.project.squareFeet,
    city: state.project.city,
    neighborhood: state.project.neighborhood,
    cta: state.project.cta || state.brandKit.ctaText,
    agentName: state.brandKit.name,
    brokerage: state.brandKit.brokerage,
    phone: state.brandKit.phone,
    email: state.brandKit.email
  };
}

function templatePipelineId() {
  const map = {
    "modern-luxury": "luxury",
    "desert-luxury": "luxury",
    "viral-fast-cut": "viral",
    "open-house": "openHouse",
    "mls-clean": "mlsClean",
    "agent-brand-builder": "luxury",
    "investor-cash-flow": "investor",
    "investor-wholesale": "investor",
    "neighborhood-authority": "neighborhood",
    "personal-brand-agent": "personalBrand"
  };
  return map[normalizeTemplateId(state.selectedTemplateId)] || "luxury";
}

function pipelineTemplateConfig() {
  return window.EstateMotionReel?.templates?.[templatePipelineId()] || {
    id: templatePipelineId(),
    sceneDuration: 2,
    motionStyle: "Depth zoom",
    transitionStyle: "soft dissolve",
    captionPlacement: "lower third",
    textStyle: "premium"
  };
}

function pipelinePhotos() {
  return orderedPhotos().map((photo, index) => ({
    ...photo,
    uploadOrder: photo.uploadOrder ?? index,
    pipelineCategory: photo.pipelineCategory || sceneToPipelineCategory(photo.category),
    classification: {
      category: photo.pipelineCategory || sceneToPipelineCategory(photo.category),
      confidence: sceneConfidence(photo),
      tags: photo.tags || []
    }
  }));
}

function createPipelineSequence() {
  if (state.project.reelPlanEdits?.scenes?.length) return sequenceFromEditedPlan(state.project.reelPlanEdits);
  return createAISequence();
}

function createAISequence() {
  const planner = window.EstateMotionReel?.sequencePlanner;
  if (planner?.createReelSequence) {
    return planner.createReelSequence(pipelinePhotos(), pipelineListingDetails(), templatePipelineId());
  }
  return {
    scenes: orderedPhotos().map((photo, index) => ({
      id: `scene-${index + 1}`,
      photo,
      category: sceneToPipelineCategory(photo.category),
      duration: Number(motionPlanForPhoto(photo, index).duration)
    }))
  };
}

function pipelineCaptions(sequence = createPipelineSequence()) {
  if (sequence.scenes?.some((scene) => scene.caption)) {
    return sequence.scenes.map((scene) => ({ sceneId: scene.id, caption: scene.caption || sceneLabel(scene.photo?.category) }));
  }
  const generator = window.EstateMotionReel?.copyGenerator;
  if (generator?.generateSceneCaptions) return generator.generateSceneCaptions(sequence, pipelineListingDetails());
  return sequence.scenes.map((scene) => ({ sceneId: scene.id, caption: sceneLabel(scene.photo.category) }));
}

function createEditableReelPlan() {
  const sequence = createAISequence();
  const captionByScene = new Map(pipelineCaptions(sequence).map((item) => [item.sceneId, item.caption]));
  return {
    id: `plan-${Date.now()}`,
    source: "ai",
    claimConfirmed: false,
    introText: state.project.introText || aiCopy().hook,
    outroText: state.project.outroText || state.project.cta || state.brandKit.ctaText,
    scenes: sequence.scenes.map((scene, index) => ({
      id: scene.id || `scene-${index + 1}`,
      photoId: scene.photo.id,
      category: scene.category || sceneToPipelineCategory(scene.photo.category),
      caption: enforceMlsSafeCaption(captionByScene.get(scene.id) || sceneLabel(scene.photo.category)),
      duration: Number(scene.duration || motionPlanForPhoto(scene.photo, index).duration || 2),
      order: index + 1
    }))
  };
}

function activeEditableReelPlan() {
  return state.project.reelPlanEdits?.scenes?.length ? state.project.reelPlanEdits : createEditableReelPlan();
}

function sequenceFromEditedPlan(plan) {
  const photosById = new Map(orderedPhotos().map((photo) => [photo.id, photo]));
  const scenes = [...(plan.scenes || [])]
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((item, index) => {
      const photo = photosById.get(item.photoId);
      if (!photo) return null;
      const category = item.category || mdRoomToPipelineCategory(item.roomType || mdPipelineCategoryToRoomType(photo.pipelineCategory || sceneToPipelineCategory(photo.category)));
      const roomType = item.roomType || mdPipelineCategoryToRoomType(category);
      const overlayParts = String(item.caption || "").split(" · ");
      const directorScene = {
        photoId: item.photoId,
        order: index + 1,
        roomType,
        visibleFeatures: Array.isArray(item.visibleFeatures) ? item.visibleFeatures : [],
        qualityScore: item.qualityScore ?? sceneConfidence(photo),
        duration: Number(item.duration || 2),
        cameraMotion: item.cameraMotion || mdCameraMotion(roomType, index),
        transition: item.transition || mdTransition(roomType, index),
        overlay: item.overlay || {
          headline: overlayParts[0] || sceneLabel(photo.category),
          subline: overlayParts.slice(1).join(" · ")
        }
      };
      return {
        id: item.id || `edited-scene-${index + 1}`,
        type: "photo",
        order: index + 1,
        photo: {
          ...photo,
          category: pipelineToSceneCategory(category),
          pipelineCategory: category,
          durableUrl: photo.durableUrl || photo.durable_url || "",
          durable_url: photo.durable_url || photo.durableUrl || ""
        },
        category,
        caption: enforceMlsSafeCaption(item.caption || sceneLabel(photo.category), item.claimConfirmed),
        duration: Number(item.duration || 2),
        role: "edited property tour",
        directorScene
      };
    })
    .filter(Boolean);
  return {
    intro: { id: "intro", type: "intro", caption: enforceMlsSafeCaption(plan.introText || aiCopy().hook, plan.claimConfirmed), duration: 2.2 },
    scenes,
    outro: { id: "outro", type: "outro", caption: enforceMlsSafeCaption(plan.outroText || state.project.cta || state.brandKit.ctaText, plan.claimConfirmed), duration: 3 },
    totalDuration: Number((scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 5.2)).toFixed(1))
  };
}

function renderDetails() {
  const copy = aiCopy();
  renderLayout(`
    <div class="screen-title"><p class="eyebrow">Pro Controls</p><h2>Fine-tune the story.</h2><p>Optional controls for agents who want to tune copy, facts, and feature cards before preview.</p></div>
    <section class="panel form-suite-panel">
      <section class="form-section-card">
        <div class="section-title"><p>Business goal</p><h3>Choose the outcome before the cut.</h3></div>
        <div class="grid-2">
          ${field("Content mode", "contentMode", { choices: contentModes.map((mode) => mode.id) })}
          ${field("Conversion CTA", "conversionGoal", { choices: conversionCtas })}
        </div>
        <div class="grid-2">${field("CTA / Calendly / link-in-bio URL", "ctaUrl")}${field("QR code URL", "qrCodeUrl")}</div>
      </section>
      <section class="form-section-card">
        <div class="section-title"><p>Listing facts</p><h3>Keep captions factual and MLS-safe.</h3></div>
        <div class="grid-2">${field("Beds", "beds")}${field("Baths", "baths")}</div>
        ${field("Square footage", "squareFeet")}
      </section>
      <details class="advanced-panel">
        <summary>Advanced copy controls</summary>
        <div class="preset-block">
          <strong>Hook presets</strong>
          <div class="preset-row">${Object.keys(hookPresets).map((preset) => `<button class="ghost" data-hook-preset="${preset}">${preset}</button>`).join("")}</div>
        </div>
        ${field("Hook text", "hookText")}
        <div class="grid-2">
          ${field("Caption tone", "captionTone", { choices: Object.keys(captionTonePresets) })}
          ${field("Social CTA", "cta", { choices: ctaPresets })}
        </div>
        ${field("Caption", "caption", { type: "textarea" })}
      </details>
      <section class="spotlight-card">
        <div><span>Address</span><strong>${escapeHtml(state.project.address)}</strong></div>
        <div><span>Area</span><strong>${escapeHtml(state.project.neighborhood || state.project.city)}</strong></div>
        <div><span>Beds/Baths</span><strong>${state.project.beds} / ${state.project.baths}</strong></div>
        <div><span>Square footage</span><strong>${escapeHtml(state.project.squareFeet)}</strong></div>
        <div><span>Price</span><strong>${escapeHtml(state.project.price)}</strong></div>
      </section>
      <div class="feature-cards">
        ${topFeatures().map((item, index) => `<div><strong>Top feature ${index + 1}</strong><br>${escapeHtml(item)}</div>`).join("")}
      </div>
      <section class="panel nested-panel seller-tool-panel">
        <div class="section-title"><p>Seller appointment weapon</p><h3>Listing-win assets</h3></div>
        <div class="feature-cards">${sellerTools.map((item) => `<div>${escapeHtml(item)}</div>`).join("")}</div>
      </section>
      <section class="panel nested-panel investor-tool-panel">
        <div class="section-title"><p>Investor / Wholesale moat</p><h3>Deal cards</h3></div>
        <div class="grid-2">
          ${investorDealFields.map((label) => investorField(label)).join("")}
        </div>
      </section>
      <button class="primary" data-next="template">Choose Style</button>
    </section>
  `);
  document.querySelectorAll("[data-hook-preset]").forEach((button) => {
    button.addEventListener("click", () => applyHookPreset(button.dataset.hookPreset));
  });
  document.querySelectorAll("[data-investor-metric]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateInvestorMetric(input.dataset.investorMetric, value, { quiet }));
  });
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics() || validatePhotos(), () => {
    showToast("AI copy refreshed");
    navigate("template");
  }));
}

function investorField(label) {
  const keyMap = {
    ARV: "arv",
    "Rehab estimate": "rehabEstimate",
    "Cap rate": "capRate",
    "Cash flow": "cashFlow",
    "Deal structure": "dealStructure",
    "Assignment fee": "assignmentFee"
  };
  const key = keyMap[label] || slug(label).replaceAll("-", "");
  const value = state.project.investorMetrics?.[key] || "";
  return `<label class="field"><span>${escapeHtml(label)}</span><input data-investor-metric="${escapeAttr(key)}" value="${escapeAttr(value)}"></label>`;
}

function updateInvestorMetric(key, value, options = {}) {
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({
    ...current,
    project: {
      ...current.project,
      investorMetrics: { ...(current.project.investorMetrics || {}), [key]: value }
    }
  }));
}

function renderTemplate() {
  const simpleTemplates = templates.filter((template) => ["modern-luxury", "viral-fast-cut", "open-house", "mls-clean", "investor-wholesale", "neighborhood-authority", "personal-brand-agent"].includes(template.id));
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Choose video style</p><h2>Pick the feel of the reel.</h2><p>Each style changes the pacing, overlays, motion system, CTA, and export manifest while keeping the listing photography real.</p></div>
    <section class="panel">
      <div class="template-showcase">
        ${simpleTemplates.map((template) => templateChoiceCard(template, simpleStyleName(template))).join("")}
      </div>
      ${!templates.length ? emptyState("No templates available", "Check template configuration before previewing.") : ""}
    </section>
    <details class="advanced-panel">
      <summary>Pro Controls: brand theme, animation, music, thumbnail</summary>
      <section class="panel">
        <div class="section-title"><p>Branded reel themes</p><h3>Agent-grade visual systems</h3></div>
        <div class="theme-grid">
          ${reelThemes.map((theme) => `<button class="theme-card ${state.project.reelTheme === theme.id ? "selected" : ""}" data-reel-theme="${theme.id}" style="--theme-accent:${theme.accent};--theme-bg:${theme.background}"><span></span><strong>${theme.name}</strong><small>${theme.description}</small></button>`).join("")}
        </div>
        <div class="grid-2">
          ${field("Text animation", "textAnimation", { choices: textAnimationStyles })}
          ${field("Music mood", "musicMood", { choices: musicMoods })}
        </div>
        <div class="grid-2">
          ${field("Outro variation", "outroVariation", { choices: outroVariations })}
          ${field("Thumbnail", "thumbnailPreset", { choices: thumbnailPresets })}
        </div>
        <button class="secondary" data-generate-variations>Generate 3 Reel Variations</button>
      </section>
    </details>
    <div class="actions">
      <button class="secondary" data-one-click>One-Click Reel</button>
      <button class="primary" data-next="processing">Start AI Processing</button>
    </div>
  `);
  document.querySelectorAll("[data-reel-theme]").forEach((button) => {
    button.addEventListener("click", () => updateProject("reelTheme", button.dataset.reelTheme));
  });
  document.querySelector("[data-generate-variations]")?.addEventListener("click", generateReelVariations);
  document.querySelectorAll("[data-template]").forEach((button) => button.addEventListener("click", () => {
    trackEvent("template_select", { templateId: button.dataset.template });
    setState((current) => ({ ...current, selectedTemplateId: button.dataset.template, project: { ...current.project, reelPlanEdits: null, motionDirectorPlan: null, motionDirectorStatus: motionDirectorIdleStatus(current.project.motionDirectorStatus) } }));
  }));
  document.querySelector("[data-one-click]").addEventListener("click", oneClickReel);
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics() || validatePhotos() || validateTemplate() || validateMarketingOSFields(), () => navigate("processing")));
}

function simpleStyleName(template) {
  const names = {
    "modern-luxury": "Luxury",
    "viral-fast-cut": "Viral",
    "open-house": "Open House",
    "mls-clean": "MLS Clean",
    "investor-wholesale": "Investor/Wholesale",
    "neighborhood-authority": "Neighborhood",
    "personal-brand-agent": "Personal Brand"
  };
  return names[template.id] || template.name;
}

function templateChoiceCard(template, displayName = template.name) {
  const recommendation = recommendedTemplateForGoal();
  const isRecommended = recommendation.template === template.id;
  return `
    <button class="template-card template-premium-card ${template.id === normalizeTemplateId(state.selectedTemplateId) ? "selected" : ""}" data-template="${template.id}" style="--template-accent:${template.accentColor}">
      <span class="template-preview">
        <span></span><b></b><i></i>
      </span>
      <span class="template-copy">
        ${isRecommended ? `<span class="recommend-badge">${escapeHtml(recommendation.label)}</span>` : ""}
        <em>${escapeHtml(template.visualCue || "Reel style")}</em>
        <strong>${escapeHtml(displayName)}</strong>
        <small>${escapeHtml(template.description)}</small>
        <small>${template.motionSpeed} motion / ${template.transitionStyle} / ${template.textPlacement} text</small>
      </span>
    </button>
  `;
}

function renderProcessing() {
  const plan = activeEditableReelPlan();
  const sequence = sequenceFromEditedPlan(plan);
  const captions = pipelineCaptions(sequence);
  const captionByScene = new Map(captions.map((item) => [item.sceneId, item.caption]));
  const preflightManifest = buildExportPayload();
  const preflightError = validatePreRenderManifest(preflightManifest, { live: !featureFlags.MOCK_RENDERING });
  const steps = [
    ["Sorting photos", "Best Listing Flow", "complete"],
    ["Identifying rooms", `${new Set(orderedPhotos().map((photo) => sceneLabel(photo.category))).size || 0} scene types`, "complete"],
    ["Adding camera motion", selectedMotionSystem().tempo, "rendering"],
    ["Syncing music", state.project.musicMood, "queued"],
    ["Rendering formats", "MP4 / Reel / MLS", "queued"]
  ];
  renderLayout(`
    <section class="processing-hero">
      <div>
        <p class="eyebrow">AI Processing</p>
        <h2>Building your listing reel.</h2>
        <p>EstateMotion is turning ${orderedPhotos().length} photos into a polished real estate video package.</p>
      </div>
      ${miniReelPreview(orderedPhotos()[0] ?? demoPhotos[0], "processing")}
    </section>
    <section class="processing-steps">
      ${steps.map(([title, detail, status]) => processingStep(title, detail, status)).join("")}
    </section>
    <section class="panel reel-plan-panel">
      <div class="section-title"><p>Lightweight reel editor</p><h3>${sequence.scenes.length} photo scenes / ${sequence.totalDuration || beatSyncPlan(renderManifestScenes(sequence)).totalDuration}s</h3></div>
      <p class="muted">Correct the AI plan before rendering. Captions are kept MLS-safe and factual by default.</p>
      ${preflightError ? `<div class="state-banner error-state"><strong>Preflight needs attention</strong><span>${escapeHtml(preflightError)}</span></div>` : `<div class="state-banner loading-state"><strong>Plan ready</strong><span>Every edited scene is linked to an uploaded photo. Durable render URLs stay preserved.</span></div>`}
      <div class="grid-2 reel-copy-editor">
        <label class="field"><span>Intro text</span><input data-plan-intro value="${escapeAttr(plan.introText || "")}"></label>
        <label class="field"><span>Outro text</span><input data-plan-outro value="${escapeAttr(plan.outroText || "")}"></label>
      </div>
      <label class="toggle-row claim-confirm"><span>Manually confirm promotional claim language</span><input type="checkbox" data-plan-claim-confirmed ${plan.claimConfirmed ? "checked" : ""}></label>
      <div class="reel-plan-grid">
        ${sequence.scenes.map((scene, index) => reelPlanRow(scene, index, captionByScene.get(scene.id))).join("")}
      </div>
      <div class="actions">
        <button class="secondary" data-reset-ai-plan>Reset to AI Plan</button>
        <button class="primary" data-preview-updated>Preview Updated Reel</button>
      </div>
    </section>
    <section class="panel processing-confidence">
      <div class="section-title"><p>Ready next</p><h3>Preview the reel before exporting.</h3></div>
      <p class="muted">The preview keeps the render manifest, Supabase photo URLs, motion plan, brand end card, captions, and mock/live render fallback intact.</p>
      <div class="actions">
        <button class="secondary" data-back-style>Change Style</button>
        <button class="primary" data-next-preview>Review Preview</button>
      </div>
    </section>
  `);
  document.querySelector("[data-back-style]").addEventListener("click", () => navigate("template"));
  document.querySelector("[data-next-preview]").addEventListener("click", () => guard(validateReelPlanBeforePreview(), () => navigate("preview")));
  bindReelPlanEditor(plan);
}

function reelPlanRow(scene, index, caption) {
  const photo = scene.photo || {};
  const sceneId = scene.id;
  return `
    <article class="reel-plan-row editor-row" data-editor-scene="${escapeAttr(sceneId)}">
      <div class="scene-thumb">
        <img src="${photo.uri}" alt="">
        <span class="scene-order-pill">${String(index + 1).padStart(2, "0")}</span>
      </div>
      <div class="scene-fields">
        <label class="scene-caption-field">
          <input data-plan-caption="${escapeAttr(sceneId)}" value="${escapeAttr(caption || scene.role || "")}" placeholder="Scene caption">
        </label>
        <div class="scene-meta-row">
          <select class="scene-category" data-plan-category="${escapeAttr(sceneId)}" aria-label="Scene type">${reelCategoryOptions().map((category) => `<option value="${category}" ${scene.category === category ? "selected" : ""}>${escapeHtml(pipelineToSceneCategory(category))}</option>`).join("")}</select>
          <label class="scene-seconds"><input type="number" min="1" max="6" step="0.1" data-plan-duration="${escapeAttr(sceneId)}" value="${Number(scene.duration || 2).toFixed(1)}"><span>sec</span></label>
        </div>
      </div>
      <div class="scene-edit-controls">
        <button class="scene-icon-btn" title="Move up" data-plan-move="${escapeAttr(sceneId)}" data-dir="-1" aria-label="Move scene up">&uarr;</button>
        <button class="scene-icon-btn" title="Move down" data-plan-move="${escapeAttr(sceneId)}" data-dir="1" aria-label="Move scene down">&darr;</button>
        <button class="scene-icon-btn scene-remove" title="Remove" data-plan-remove="${escapeAttr(sceneId)}" aria-label="Remove scene">&times;</button>
      </div>
    </article>
  `;
}

function reelCategoryOptions() {
  return window.EstateMotionReel?.imageClassifier?.allowedCategories || ["exterior hero", "kitchen", "living room", "bedroom", "bathroom", "backyard/outdoor", "amenity", "detail/other"];
}

function bindReelPlanEditor(plan) {
  ensureReelPlanPersisted(plan);
  const introInput = document.querySelector("[data-plan-intro]");
  if (introInput) bindStableField(introInput, (value, quiet) => updateReelPlanField("introText", value, { quiet }));
  const outroInput = document.querySelector("[data-plan-outro]");
  if (outroInput) bindStableField(outroInput, (value, quiet) => updateReelPlanField("outroText", value, { quiet }));
  document.querySelector("[data-plan-claim-confirmed]")?.addEventListener("change", (event) => updateReelPlanField("claimConfirmed", event.target.checked));
  document.querySelectorAll("[data-plan-category]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateReelPlanScene(input.dataset.planCategory, { category: value }, { quiet }));
  });
  document.querySelectorAll("[data-plan-caption]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateReelPlanScene(input.dataset.planCaption, { caption: value }, { quiet }));
  });
  document.querySelectorAll("[data-plan-duration]").forEach((input) => {
    bindStableField(input, (value, quiet) => updateReelPlanScene(input.dataset.planDuration, { duration: Number(value || 2) }, { quiet }));
  });
  document.querySelectorAll("[data-plan-move]").forEach((button) => {
    button.addEventListener("click", () => moveReelPlanScene(button.dataset.planMove, Number(button.dataset.dir)));
  });
  document.querySelectorAll("[data-plan-remove]").forEach((button) => {
    button.addEventListener("click", () => removeReelPlanScene(button.dataset.planRemove));
  });
  document.querySelector("[data-reset-ai-plan]")?.addEventListener("click", resetReelPlanToAi);
  document.querySelector("[data-preview-updated]")?.addEventListener("click", () => guard(validateReelPlanBeforePreview(), () => navigate("preview")));
}

function ensureReelPlanPersisted(plan) {
  if (state.project.reelPlanEdits?.scenes?.length) return;
  state = { ...state, project: { ...state.project, reelPlanEdits: plan } };
  saveState();
}

function updateReelPlanField(key, value, options = {}) {
  if (key === "claimConfirmed") {
    const plan = activeEditableReelPlan();
    saveEditedReelPlan({ ...plan, claimConfirmed: Boolean(value) });
    showToast(value ? "Manual claim confirmation enabled" : "MLS-safe claim filtering enabled");
    return;
  }
  const safeValue = enforceMlsSafeCaption(value, activeEditableReelPlan().claimConfirmed);
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({
    ...current,
    project: {
      ...current.project,
      [key]: safeValue,
      reelPlanEdits: { ...activeEditableReelPlan(), [key]: safeValue }
    }
  }));
}

function updateReelPlanScene(sceneId, patch, options = {}) {
  const plan = activeEditableReelPlan();
  const normalizedPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "caption")) {
    const needsConfirmation = captionNeedsManualClaimConfirmation(normalizedPatch.caption);
    normalizedPatch.caption = enforceMlsSafeCaption(normalizedPatch.caption, plan.claimConfirmed);
    if (needsConfirmation && !plan.claimConfirmed) showToast("Unsupported claim removed for MLS-safe copy. Use factual listing details only.", "error");
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "duration")) {
    normalizedPatch.duration = Math.max(1, Math.min(6, Number(normalizedPatch.duration || 2)));
  }
  const scenes = plan.scenes.map((scene) => scene.id === sceneId ? { ...scene, ...normalizedPatch } : scene);
  saveEditedReelPlan({ ...plan, scenes }, options);
}

function moveReelPlanScene(sceneId, direction) {
  const plan = activeEditableReelPlan();
  const scenes = [...plan.scenes].sort((a, b) => a.order - b.order);
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= scenes.length) return;
  [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
  saveEditedReelPlan({ ...plan, scenes: scenes.map((scene, order) => ({ ...scene, order: order + 1 })) });
  showToast("Scene order updated");
}

function removeReelPlanScene(sceneId) {
  const plan = activeEditableReelPlan();
  const scenes = plan.scenes.filter((scene) => scene.id !== sceneId).map((scene, order) => ({ ...scene, order: order + 1 }));
  if (scenes.length < 3) {
    setError("Keep at least 3 photo scenes in the final reel.");
    return;
  }
  saveEditedReelPlan({ ...plan, scenes });
  showToast("Scene removed from final reel");
}

function resetReelPlanToAi() {
  const plan = createEditableReelPlan();
  saveEditedReelPlan(plan);
  showToast("AI reel plan restored");
}

function saveEditedReelPlan(plan, options = {}) {
  const normalized = {
    ...plan,
    claimConfirmed: Boolean(plan.claimConfirmed),
    introText: enforceMlsSafeCaption(plan.introText || aiCopy().hook, plan.claimConfirmed),
    outroText: enforceMlsSafeCaption(plan.outroText || state.project.cta || state.brandKit.ctaText, plan.claimConfirmed),
    scenes: [...(plan.scenes || [])].sort((a, b) => a.order - b.order).map((scene, index) => ({
      ...scene,
      caption: enforceMlsSafeCaption(scene.caption || "", plan.claimConfirmed),
      duration: Math.max(1, Math.min(6, Number(scene.duration || 2))),
      order: index + 1
    }))
  };
  const commit = options.quiet ? setStateQuietly : setState;
  commit((current) => ({ ...current, project: { ...current.project, reelPlanEdits: normalized, introText: normalized.introText, outroText: normalized.outroText } }));
}

function validateReelPlanBeforePreview() {
  const plan = activeEditableReelPlan();
  if (!plan.scenes?.length) return "Create a reel plan before previewing.";
  if (plan.scenes.length < 3) return "Keep at least 3 scenes in the final reel.";
  const marketingError = validateMarketingOSFields();
  if (marketingError) return marketingError;
  const manifest = buildExportPayload();
  return validatePreRenderManifest(manifest, { live: !featureFlags.MOCK_RENDERING });
}

function processingStep(title, detail, status) {
  return `
    <article class="processing-step ${status}">
      <span></span>
      <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>
      <b>${escapeHtml(status)}</b>
    </article>
  `;
}

function renderPreview() {
  const sequence = createPipelineSequence();
  const photos = sequence.scenes.length ? sequence.scenes.map((scene) => scene.photo) : orderedPhotos();
  const photo = photos[state.selectedScene] ?? photos[0] ?? demoPhotos[0];
  const copy = aiCopy();
  const template = selectedTemplate();
  const theme = selectedReelTheme();
  const currentSceneLabel = sceneBeatLabel(photo, state.selectedScene, photos.length);
  const pacing = reelPacing(photos);
  const currentPlan = pacing[state.selectedScene] ?? motionPlanForPhoto(photo, state.selectedScene);
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">${template.name}</p><h2>Review the finished reel.</h2><p>Large vertical preview, scene pacing, text overlays, brand end card, and export readiness in one place.</p></div>
    ${photos.length ? `<section class="preview-suite">
      <div class="video-player-shell">
        <div class="player-chrome"><span>9:16 Reel Preview</span><b>${escapeHtml(template.name)}</b></div>
        ${reelStage(photo, copy, template, state.selectedScene, photos.length)}
      </div>
      <aside class="preview-inspector panel export-status-card">
        <div class="section-title"><p>Export readiness</p><h3>${state.exportResult ? "Rendered asset ready" : "Ready to render"}</h3></div>
        <p class="muted">${escapeHtml(photo.fileName)} plays as a ${currentPlan.duration}s ${currentPlan.motionStyle} beat. Depth simulation preserves property integrity with no hallucinated rooms.</p>
        <div class="metric-row"><span>Current scene</span><b>${escapeHtml(sceneLabel(photo.category))}</b></div>
        <div class="metric-row"><span>Motion label</span><b>${escapeHtml(currentPlan.motionStyle)}</b></div>
        <div class="metric-row"><span>Beat sync</span><b>${escapeHtml(currentPlan.beatMarker)}</b></div>
        <div class="metric-row"><span>Text overlay</span><b>${escapeHtml(state.project.textAnimation)}</b></div>
        <div class="metric-row"><span>Brand end card</span><b>${state.project.brandingVisible ? "Included" : "Hidden"}</b></div>
        <div class="metric-row"><span>Formats</span><b>9:16 / 16:9 / 1:1</b></div>
        <div class="metric-row"><span>Queue</span><b>${state.renderQueue.length ? state.renderQueue[0].status : "not queued"}</b></div>
      </aside>
    </section>` : emptyState("Preview needs photos", "Upload at least 3 listing photos to preview the reel.")}
    <div class="actions">
      <button class="secondary" data-scene="-1">Previous scene</button>
      <button class="secondary" data-scene="1">Next scene</button>
      <button class="ghost" data-edit>Pro Controls</button>
      <button class="primary" data-next="export">Export reel</button>
    </div>
    <section class="panel scene-card-panel">
      <div class="section-title"><p>Real reel timeline</p><h3>${photos.length} scenes / ${beatSyncPlan(renderManifestScenes()).totalDuration}s</h3></div>
      <div class="scene-card-grid">
        ${photos.length ? photos.map((item, index) => sceneCard(item, index, pacing[index])).join("") : emptyState("No sequence yet", "Photos appear here after upload.")}
      </div>
    </section>
    ${photos.length ? beforeAfterPreview(photos[0], photo, template) : ""}
    ${sellerPreviewPackage()}
    <details class="advanced-panel">
      <summary>Advanced Customization: features, property facts, and brand end card</summary>
      <section class="panel">
        <div class="section-title"><p>Neighborhood spotlight</p><h3>${escapeHtml(state.project.thumbnailPreset)}</h3></div>
        <section class="spotlight-card">
          <div><span>Address</span><strong>${escapeHtml(state.project.address)}</strong></div>
          <div><span>Area</span><strong>${escapeHtml(state.project.neighborhood || state.project.city)}</strong></div>
          <div><span>Beds/Baths</span><strong>${state.project.beds} / ${state.project.baths}</strong></div>
          <div><span>Square footage</span><strong>${escapeHtml(state.project.squareFeet)}</strong></div>
          <div><span>Price</span><strong>${escapeHtml(state.project.price)}</strong></div>
        </section>
      </section>
      <section class="panel">
        <div class="section-title"><p>Top 3 Features</p><h3>Auto card</h3></div>
        <div class="feature-cards">${topFeatures().map((item, index) => `<div><strong>${index + 1}</strong><br>${escapeHtml(item)}</div>`).join("")}</div>
      </section>
      <section class="panel brand-end-preview">
        <div class="section-title"><p>Brand end card</p><h3>${escapeHtml(state.brandKit.name)} / ${escapeHtml(state.brandKit.brokerage)}</h3></div>
        ${agentStrip()}
      </section>
    </details>
    ${state.project.reelVariations?.length ? `<section class="panel"><div class="section-title"><p>Generated variations</p><h3>3 reel directions</h3></div><div class="variation-grid">${state.project.reelVariations.map((variation) => `<article><strong>${variation.name}</strong><span>${escapeHtml(variation.settings.textAnimation)} / ${escapeHtml(variation.settings.musicMood)}</span></article>`).join("")}</div></section>` : ""}
    <details class="advanced-panel">
      <summary>Pro Controls: copy, compliance, and full timeline</summary>
      <section class="panel">
      <div class="section-title"><p>Feature cards</p><h3>AI-style highlights</h3></div>
      <div class="feature-cards">${copy.highlights.map((item) => `<div>${escapeHtml(item)}</div>`).join("")}</div>
      </section>
      <section class="panel compliance-preview">
        <div class="section-title"><p>Compliance</p><h3>${state.brandKit.complianceEnabled ? "Included" : "Hidden"}</h3></div>
        ${complianceBlock()}
      </section>
    </details>
  `);
  document.querySelectorAll("[data-scene]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Math.max(0, Math.min(photos.length - 1, state.selectedScene + Number(button.dataset.scene)));
      setState({ selectedScene: next });
    });
  });
  document.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => setState({ selectedScene: Number(button.dataset.jump) })));
  document.querySelector("[data-edit]").addEventListener("click", () => navigate("edit"));
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics() || validatePhotos() || validateTemplate() || validateMarketingOSFields(), () => navigate("export")));
}

function sceneCard(item, index, pacing) {
  return `
    <button class="scene-card ${state.selectedScene === index ? "active" : ""}" data-jump="${index}">
      <img src="${item.uri}" alt="">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(sceneLabel(item.category))}</strong>
      <small>${escapeHtml(pacing?.motionStyle || "Push-in")} / ${pacing?.duration || "2.0"}s</small>
    </button>
  `;
}

function beforeAfterPreview(firstPhoto, activePhoto, template) {
  return `
    <section class="panel before-after-panel">
      <div class="section-title"><p>Before / After</p><h3>From listing photos to brand-grade reel.</h3></div>
      <div class="before-after-grid">
        <article>
          <span>Before</span>
          <img src="${firstPhoto.uri}" alt="">
          <strong>Raw listing photo</strong>
          <small>Original uploaded image stays intact.</small>
        </article>
        <article class="after-card">
          <span>After</span>
          <div class="after-reel-frame">
            <img src="${activePhoto.uri}" alt="">
            <b>${escapeHtml(template.name)}</b>
            <strong>${escapeHtml(aiCopy().hook)}</strong>
          </div>
          <small>Camera motion, overlays, captions, CTA, and brand end card.</small>
        </article>
      </div>
    </section>
  `;
}

function reelStage(photo, copy, template, index = 0, total = 1) {
  const beat = sceneBeatLabel(photo, index, total);
  const pacing = reelPacing(orderedPhotos())[index] ?? { move: "push-in", duration: "2.0" };
  const theme = selectedReelTheme();
  const overlay = modeSpecificOverlay({ photo, category: sceneToPipelineCategory(photo.category) }, index, total);
  return `
    <section class="reel-stage reel-${slug(pacing.move)} text-${slug(state.project.textAnimation)}" style="border-color:${theme.accent};--reel-accent:${theme.accent};--reel-bg:${theme.background}">
      <img src="${photo.uri}" alt="">
      <div class="reel-overlay">
        <div class="intro-card">
          <span class="badge">${beat}</span>
          <span>${escapeHtml(state.project.city)} / ${escapeHtml(state.project.neighborhood)}</span>
        </div>
        <div class="thumbnail-card">${escapeHtml(state.project.thumbnailPreset)}</div>
        ${overlay.headline ? `<div class="mode-overlay-card mode-${escapeAttr(overlay.variant)}"><strong>${escapeHtml(overlay.label)}</strong><span>${escapeHtml(overlay.headline)}</span>${overlay.lines?.length ? `<small>${overlay.lines.map(escapeHtml).join(" / ")}</small>` : ""}</div>` : ""}
        <div class="reel-hook">
          <h3>${escapeHtml(copy.hook)}</h3>
          <p>${state.project.price} - ${state.project.beds} BD - ${state.project.baths} BA - ${state.project.squareFeet} SQ FT</p>
        </div>
        <div class="reel-progress">${Array.from({ length: total }, (_, dotIndex) => `<span class="${dotIndex <= index ? "active" : ""}"></span>`).join("")}</div>
        ${state.project.brandingVisible ? outroBlock() : ""}
        ${state.brandKit.complianceEnabled ? `<small class="reel-disclaimer">${escapeHtml(state.brandKit.listingCourtesyOf)}</small>` : ""}
      </div>
    </section>
  `;
}

function sellerPreviewPackage() {
  if (state.project.contentMode !== "seller-lead-magnet") return "";
  const photos = orderedPhotos().slice(0, 4);
  return `
    <section class="panel seller-preview-package">
      <div class="section-title"><p>Seller preview package</p><h3>Win-the-listing marketing card</h3></div>
      <div class="seller-preview-layout">
        <div class="seller-preview-photos">
          ${photos.map((photo) => `<img src="${photo.uri}" alt="${escapeAttr(photo.fileName || "Listing photo")}">`).join("")}
        </div>
        <div class="seller-preview-copy">
          <span class="recommend-badge">Seller Lead Magnet</span>
          <h3>See what your home could look like online</h3>
          <p>Built from uploaded listing photos with ${escapeHtml(selectedTemplate().name)} styling, MLS-safe captions, and a ${escapeHtml(state.project.conversionGoal || state.project.cta)} CTA.</p>
          ${agentStrip()}
          <small>No guaranteed sale price or sale outcome. This is a marketing preview for presentation use.</small>
        </div>
      </div>
    </section>
  `;
}

function sceneBeatLabel(photo, index, total) {
  if (index === 0) return "Exterior hero";
  if (index === total - 1) return "Final reason to tour";
  return sceneLabel(photo?.category ?? "Detail shots");
}

function reelPacing(photos) {
  return photos.map((photo, index) => motionPlanForPhoto(photo, index));
}

function selectedMotionSystem() {
  const pack = templatePipelineId();
  if (pack === "viral") return motionSystems.Viral;
  if (pack === "investor") return motionSystems.Investor;
  if (pack === "mlsClean") return motionSystems.MLS;
  if (pack === "openHouse") return motionSystems["Open House"];
  if (state.project.captionTone === "Viral") return motionSystems.Viral;
  if (state.project.captionTone === "Investor" || state.project.reelTheme === "investor-cash-flow") return motionSystems.Investor;
  if (state.project.listingType === "Open House" || state.project.reelTheme === "open-house-fast-cut") return motionSystems["Open House"];
  if (state.project.captionTone === "First-time buyer" || state.project.reelTheme === "first-time-buyer-friendly") return motionSystems["First-time buyer"];
  return motionSystems.Luxury;
}

function motionPlanForPhoto(photo, index = 0) {
  const category = sceneLabel(photo?.category ?? "Detail shots");
  const system = selectedMotionSystem();
  const intelligence = sceneIntelligence[category] ?? sceneIntelligence["Detail shots"];
  const motionStyle = sceneSpecificMotion(category, index, intelligence, system);
  const duration = beatTimedDuration(category, index, system).toFixed(2);
  const beatIndex = index + 1;
  return {
    sceneId: photo?.id,
    sceneType: category,
    confidence: sceneConfidence(photo ?? { fileName: "", order: index + 1 }),
    motionStyle,
    renderMotion: motionStyle,
    move: motionToClass(motionStyle),
    duration,
    transition: sceneSpecificTransition(category, system),
    beatMarker: `Beat ${beatIndex}${beatIndex % system.beatEvery === 0 ? " / transition accent" : ""}`,
    musicPacing: system.tempo,
    depthModel: ["Exterior hero", "Backyard / pool", "Living room"].includes(category) ? "layered parallax" : "subtle monocular depth",
    realismGuardrail: "Preserve exact property geometry; no hallucinated rooms, windows, furniture, or warped architecture.",
    overlayText: intelligence.overlay
  };
}

function sceneSpecificMotion(category, index, intelligence, system) {
  const pack = templatePipelineId();
  if (pack === "viral") {
    if (index === 0 || category === "Exterior hero") return "Speed ramp push";
    if (category === "Kitchen") return "Whip pan";
    if (category === "Living room") return "Punch zoom";
    if (category === "Bathroom") return "Vertical snap";
    return index % 2 ? "Push-in" : "Orbit simulation";
  }
  if (pack === "mlsClean") {
    if (category === "Kitchen" || category === "Living room") return "Slow pan";
    if (category === "Bathroom") return "Bathroom clean slide";
    return "Push-in";
  }
  if (pack === "investor") {
    if (index === 0 || category === "Exterior hero") return "Pull-out";
    if (category === "Kitchen" || category === "Living room") return "Slow pan";
    return "Detail sweep";
  }
  if (index === 0 || category === "Exterior hero") return "Parallax depth";
  if (category === "Kitchen") return "Kitchen lateral pan";
  if (category === "Living room") return "Living depth zoom";
  if (category === "Primary bedroom") return "Bedroom gentle fade";
  if (category === "Bathroom") return "Bathroom clean slide";
  if (category === "Backyard / pool") return "Orbit simulation";
  return intelligence.suggestedMotion || system.defaultMotion;
}

function sceneSpecificTransition(category, system) {
  const pack = templatePipelineId();
  const map = pack === "viral" ? {
    "Exterior hero": "zoom transition",
    Kitchen: "whip pan",
    "Living room": "match cut",
    "Primary bedroom": "blur wipe",
    Bathroom: "whip pan",
    "Backyard / pool": "match cut"
  } : pack === "mlsClean" ? {
    "Exterior hero": "crossfade",
    Kitchen: "clean dissolve",
    "Living room": "clean dissolve",
    "Primary bedroom": "gentle fade",
    Bathroom: "clean slide",
    "Backyard / pool": "crossfade"
  } : pack === "investor" ? {
    "Exterior hero": "match cut",
    Kitchen: "clean cut",
    "Living room": "match cut",
    "Primary bedroom": "clean dissolve",
    Bathroom: "clean slide",
    "Backyard / pool": "match cut"
  } : {
    "Exterior hero": "light leak",
    Kitchen: "blur wipe",
    "Living room": "depth dissolve",
    "Primary bedroom": "gentle fade",
    Bathroom: "clean slide",
    "Backyard / pool": "light leak"
  };
  return map[category] || system.transition || "soft dissolve";
}

function beatTimedDuration(category, index, system) {
  const base = Number(system.baseDuration || 2);
  const pack = templatePipelineId();
  const packMultiplier = pack === "viral" ? 0.74 : pack === "mlsClean" ? 1.08 : pack === "investor" ? 0.9 : 1;
  const beat = base + sceneDurationAdjustment(category, index);
  return Math.max(1.15, Math.min(3.4, beat * packMultiplier));
}

function selectedMusicTrack() {
  const pack = templatePipelineId();
  const tracks = {
    luxury: { id: "luxury", label: "Luxury: slow cinematic", url: featureFlags.MUSIC_LUXURY_URL, bpm: 72, mood: "slow cinematic" },
    viral: { id: "viral", label: "Viral: upbeat social", url: featureFlags.MUSIC_VIRAL_URL, bpm: 118, mood: "upbeat social" },
    openHouse: { id: "viral", label: "Viral: upbeat social", url: featureFlags.MUSIC_VIRAL_URL, bpm: 118, mood: "upbeat social" },
    mlsClean: { id: "mlsClean", label: "MLS Clean: no music or subtle ambient", url: featureFlags.MUSIC_MLS_CLEAN_URL, bpm: 64, mood: "subtle ambient", optional: true },
    investor: { id: "investor", label: "Investor: energetic minimal", url: featureFlags.MUSIC_INVESTOR_URL, bpm: 104, mood: "energetic minimal" }
  };
  const track = tracks[pack] || tracks.luxury;
  return {
    ...track,
    configured: Boolean(track.url),
    fallback: track.url ? "" : "No music file configured; render will use silent beat-timed pacing."
  };
}

function sceneDurationAdjustment(category, index) {
  if (index === 0) return 0.35;
  if (["Kitchen", "Living room", "Backyard / pool"].includes(category)) return 0.18;
  if (["Detail shots", "Bathroom"].includes(category)) return -0.25;
  return 0;
}

function motionToClass(motionStyle) {
  const map = {
    "Push-in": "push-in",
    "Pull-out": "pull-out",
    "Slow pan": "slow-pan",
    "Depth zoom": "depth-zoom",
    "Parallax depth": "parallax-depth",
    "Exterior slow zoom": "depth-zoom",
    "Kitchen lateral pan": "slow-pan",
    "Living depth zoom": "depth-zoom",
    "Bedroom gentle fade": "pull-out",
    "Bathroom clean slide": "vertical-social-framing",
    "Orbit simulation": "orbit-simulation",
    "Vertical social framing": "vertical-social-framing",
    "Speed ramp push": "speed-ramp",
    "Whip pan": "whip-pan",
    "Punch zoom": "punch-zoom",
    "Vertical snap": "vertical-snap",
    "Detail sweep": "detail-sweep"
  };
  return map[motionStyle] ?? "push-in";
}

function renderEdit() {
  const copy = aiCopy();
  renderLayout(`
    <div class="screen-title"><p class="eyebrow">Edit</p><h2>Reel Copy & Order</h2><p>Change hook, CTA, caption, template, branding visibility, and photo order before export.</p></div>
    <section class="panel">
      <div class="preset-block">
        <strong>Hook presets</strong>
        <div class="preset-row">${Object.keys(hookPresets).map((preset) => `<button class="ghost" data-hook-preset="${preset}">${preset}</button>`).join("")}</div>
      </div>
      ${field("Hook", "hookText")}
      <div class="grid-2">
        ${field("Caption tone", "captionTone", { choices: Object.keys(captionTonePresets) })}
        ${field("Social CTA", "cta", { choices: ctaPresets })}
      </div>
      ${field("Caption", "caption", { type: "textarea" })}
      ${field("Template", "unusedTemplate", { choices: templates.map((template) => template.name) }).replace('data-project="unusedTemplate"', 'data-template-select')}
      <label class="field"><span>Branding visibility</span><select data-branding-visible><option value="true" ${state.project.brandingVisible ? "selected" : ""}>Visible</option><option value="false" ${!state.project.brandingVisible ? "selected" : ""}>Hidden</option></select></label>
      <div class="feature-cards"><div><strong>Instagram caption</strong><br>${escapeHtml(copy.instagramCaption).replaceAll("\n", "<br>")}</div><div><strong>Hashtags</strong><br>${copy.hashtags.join(" ")}</div><div><strong>Voiceover</strong><br>${escapeHtml(copy.voiceoverScript)}</div></div>
      <button class="primary" data-next="export">Export</button>
    </section>
    <section class="photo-grid">${orderedPhotos().length ? orderedPhotos().map((photo, index) => photoCard(photo, index)).join("") : emptyState("No editable photos", "Upload photos before editing scene order.")}</section>
  `);
  document.querySelectorAll("[data-hook-preset]").forEach((button) => {
    button.addEventListener("click", () => applyHookPreset(button.dataset.hookPreset));
  });
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics() || validatePhotos() || validateTemplate() || validateMarketingOSFields(), () => navigate("export")));
  const templateSelect = document.querySelector("[data-template-select]");
  templateSelect.value = selectedTemplate().name;
  templateSelect.addEventListener("input", () => {
    const template = templates.find((item) => item.name === templateSelect.value);
    if (template) setState({ selectedTemplateId: template.id });
  });
  document.querySelector("[data-branding-visible]").addEventListener("input", (event) => updateProject("brandingVisible", event.target.value === "true"));
  bindPhotoControls();
}

function renderBrand() {
  renderLayout(`
    <div class="screen-title"><p class="eyebrow">Brand Kit</p><h2>Agent Branding</h2><p>This feeds onboarding, personal brand end cards, social captions, and compliance footers.</p></div>
    <section class="panel elevated">
      <div class="grid-2">${brandField("Name", "name")}${brandField("Brokerage", "brokerage")}</div>
      <div class="grid-2">${brandField("Headshot URL", "headshotUri")}${brandField("Logo URL", "logoUri")}</div>
      <div class="grid-2">
        <div class="field"><label>Upload headshot</label><input type="file" accept="image/*" data-brand-upload="headshot"></div>
        <div class="field"><label>Upload logo</label><input type="file" accept="image/*" data-brand-upload="logo"></div>
      </div>
      <div class="grid-2">${brandField("Phone", "phone")}${brandField("Email", "email")}</div>
      ${brandField("Website", "website")}
      ${brandField("Instagram", "instagram")}
      <div class="grid-2">${brandField("Primary color", "primaryColor")}${brandField("Accent color", "accentColor")}</div>
      ${brandField("CTA text", "ctaText")}
    </section>
    <section class="panel">
      <div class="section-title"><p>Compliance mode</p><h3>Disclaimers</h3></div>
      ${brandToggle("Enable compliance fields", "complianceEnabled")}
      ${brandToggle("Equal Housing Opportunity", "equalHousing")}
      ${brandTextarea("Listing courtesy of", "listingCourtesyOf")}
      ${brandTextarea("Brokerage disclaimer", "brokerageDisclaimer")}
      ${brandTextarea("MLS disclaimer placeholder", "mlsDisclaimer")}
      ${complianceBlock()}
      <button class="primary" data-save-brand>Save brand kit</button>
    </section>
  `);
  document.querySelector("[data-save-brand]").addEventListener("click", () => guard(validateBrandKit(), () => showToast("Brand kit saved")));
  bindBrandUploads();
}

function renderExport() {
  const copy = aiCopy();
  const template = selectedTemplate();
  const pack = contentPack();
  const result = buildExportPayload();
  const preflightError = validatePreRenderManifest(result, { live: !featureFlags.MOCK_RENDERING });
  const mp4Ready = !featureFlags.MOCK_RENDERING;
  const renderUrl = state.exportResult?.mp4Url || state.exportResult?.output || "";
  const exportOptions = [
    ["Instagram Reels", "Vertical 9:16 branded MP4", "1080x1920"],
    ["TikTok", "Fast mobile-first social cut", "9:16"],
    ["YouTube Shorts", "Shorts-ready vertical export", "9:16"],
    ["MLS Clean", "Compliance-safe clean version", "Unbranded"],
    ["Caption + Thumbnail", "Post copy, hashtags, and cover asset", "Handoff"]
  ];
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Export</p><h2>Leave with social-ready assets.</h2><p>${featureFlags.MOCK_RENDERING ? "Mock rendering is enabled. Queue states are real locally; MP4 output falls back to JSON and preview HTML." : "Live rendering is enabled. EstateMotion will call the render worker for MP4 jobs."}</p></div>
    <section class="export-delivery-grid">
      <div class="video-player-shell export-preview-shell">
        <div class="player-chrome"><span>Delivery preview</span><b>${escapeHtml(template.name)}</b></div>
        ${reelStage(orderedPhotos()[0] ?? demoPhotos[0], copy, template, 0, Math.max(1, orderedPhotos().length))}
      </div>
      <section class="panel elevated export-command">
        <div class="section-title"><p>Final output</p><h3>${state.exportResult ? "Render ready" : "Ready to create"}</h3></div>
        ${preflightError ? `<div class="state-banner error-state"><strong>Render failed or blocked</strong><span>${escapeHtml(preflightError)} Re-upload photos in Supabase mode or switch back to mock rendering for a local demo.</span></div>` : `<div class="state-banner loading-state"><strong>${featureFlags.MOCK_RENDERING ? "Mock export ready" : "MP4 render ready"}</strong><span>Every photo scene is linked to an uploaded image. ${featureFlags.MOCK_RENDERING ? "Mock exports can use local preview URLs." : "Live MP4 export will require durable public Supabase URLs."}</span></div>`}
        <div class="export-option-grid">${exportOptions.map(([title, body, format]) => exportOptionCard(title, body, format)).join("")}</div>
        <div class="actions">
          <button class="primary" data-queue-pack>${mp4Ready ? "Create MP4 exports" : "Create mock export pack"}</button>
          <button class="secondary" data-download-json>Download JSON manifest</button>
          <button class="secondary" data-download-html>Download preview HTML</button>
          <button class="ghost" data-download-copy>Download caption + hashtags</button>
        </div>
      </section>
    </section>
    ${renderQueuePanel()}
    <details class="advanced-panel">
      <summary>Advanced Customization: full content pack manifest</summary>
    <section class="panel elevated">
      <div class="section-title"><p>Content Pack</p><h3>${pack.length} deliverables</h3></div>
      <div class="pack-grid">${pack.map((item) => contentPackCard(item)).join("")}</div>
    </section>
    </details>
    <section class="panel share-panel">
      <div class="section-title"><p>Share & downloads</p><h3>Agent handoff assets</h3></div>
      <div class="actions">
        <button class="secondary" data-download-html>Download reel preview HTML</button>
        <button class="secondary" data-download-json>Download content pack manifest</button>
        <button class="ghost" data-copy-caption>Copy Instagram caption</button>
        <button class="ghost" data-copy-hashtags>Copy hashtags</button>
      </div>
    </section>
    <section class="panel">
      <div class="section-title"><p>${template.name}</p><h3>Caption assets</h3></div>
      <div class="feature-cards">
        <div><strong>Caption</strong><br>${escapeHtml(copy.instagramCaption).replaceAll("\n", "<br>")}</div>
        <div><strong>Hashtags</strong><br>${copy.hashtags.join(" ")}</div>
        <div><strong>MP4 status</strong><br>${state.exportResult ? `Ready: ${state.exportResult.createdAt}${renderUrl ? `<br><a href="${escapeHtml(renderUrl)}" target="_blank" rel="noreferrer">Open rendered MP4</a>` : ""}` : "Ready to export"}</div>
      </div>
    </section>
    ${postExportReferralPanel()}
    ${betaFeedbackPanel()}
  `);
  document.querySelector("[data-queue-pack]").addEventListener("click", queueContentPack);
  document.querySelectorAll("[data-download-json]").forEach((button) => button.addEventListener("click", () => {
    trackEvent("export_manifest_click", { screen: "export" });
    downloadFile(`${slug(state.project.title)}-render-manifest.json`, "application/json", JSON.stringify(result, null, 2));
    showToast("Content pack manifest downloaded");
  }));
  document.querySelectorAll("[data-download-html]").forEach((button) => button.addEventListener("click", () => {
    trackEvent("export_preview_click", { screen: "export" });
    downloadFile(`${slug(state.project.title)}-preview.html`, "text/html", buildPreviewHtml(result));
    showToast("Preview HTML downloaded");
  }));
  document.querySelector("[data-download-copy]").addEventListener("click", () => {
    trackEvent("export_copy_click", { type: "caption_hashtags_file" });
    downloadFile(`${slug(state.project.title)}-caption-hashtags.txt`, "text/plain", `${copy.instagramCaption}\n\n${copy.hashtags.join(" ")}`);
  });
  document.querySelector("[data-copy-caption]").addEventListener("click", () => {
    trackEvent("copy_caption_click", { screen: "export" });
    copyText(copy.instagramCaption, "Instagram caption copied");
  });
  document.querySelector("[data-copy-hashtags]").addEventListener("click", () => {
    trackEvent("copy_hashtags_click", { screen: "export" });
    copyText(copy.hashtags.join(" "), "Hashtags copied");
  });
  document.querySelector("[data-copy-referral]")?.addEventListener("click", () => {
    trackEvent("beta_referral_copy", { screen: "export" });
    copyText(`${window.location.origin}/beta?ref=${encodeURIComponent(state.brandKit.name || "agent")}`, "Beta referral link copied");
  });
  if (!state.exportResult && shouldUseLocalPersistence()) {
    setTimeout(() => setState({ exportResult: { createdAt: new Date().toLocaleString(), output: `${slug(state.project.title)}-mock-render` } }), 0);
  }
  document.querySelector("[data-submit-beta-feedback]")?.addEventListener("click", submitBetaFeedback);
}

function exportOptionCard(title, body, format) {
  return `<article class="export-option"><span>${escapeHtml(format)}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(body)}</small></article>`;
}

function betaFeedbackPanel() {
  return `
    <section class="panel beta-feedback-panel">
      <div class="section-title"><p>Beta feedback</p><h3>Help us tune EstateMotion for working agents.</h3></div>
      <div class="beta-checklist compact-checklist">
        ${["Was the reel postable?", "Did the photos appear correctly?", "Were captions accurate?", "What would stop you from paying?"].map((item) => `<article><span></span><strong>${escapeHtml(item)}</strong></article>`).join("")}
      </div>
      <div class="grid-2">
        <label class="field"><span>Rating</span><select data-beta-feedback="rating">${["5", "4", "3", "2", "1"].map((rating) => `<option value="${rating}" ${state.betaFeedbackForm.rating === rating ? "selected" : ""}>${rating} / 5</option>`).join("")}</select></label>
        <label class="field"><span>Was this usable enough to post?</span><select data-beta-feedback="usableEnough"><option value="yes" ${state.betaFeedbackForm.usableEnough === "yes" ? "selected" : ""}>Yes</option><option value="almost" ${state.betaFeedbackForm.usableEnough === "almost" ? "selected" : ""}>Almost</option><option value="no" ${state.betaFeedbackForm.usableEnough === "no" ? "selected" : ""}>No</option></select></label>
      </div>
      <label class="field"><span>Optional feedback</span><textarea data-beta-feedback="feedback" placeholder="What would make this easier to post?">${escapeHtml(state.betaFeedbackForm.feedback)}</textarea></label>
      <div class="actions">
        <button class="primary" data-submit-beta-feedback>Submit beta feedback</button>
        <span class="muted">${state.betaFeedback.length} response${state.betaFeedback.length === 1 ? "" : "s"} captured</span>
      </div>
    </section>
  `;
}

function postExportReferralPanel() {
  const referralLink = `${window.location.origin}/beta?ref=${encodeURIComponent(state.brandKit.name || "agent")}`;
  return `
    <section class="panel referral-panel elevated">
      <div class="section-title"><p>Referral CTA</p><h3>Want this for your listings?</h3></div>
      <p class="muted">Share the beta with another agent, team lead, investor buyer list, or brokerage partner.</p>
      <div class="referral-link"><code>${escapeHtml(referralLink)}</code></div>
      <div class="actions">
        <button class="primary" data-copy-referral>Copy referral link</button>
        <a class="secondary button-link" href="/beta">Open beta page</a>
      </div>
    </section>
  `;
}

async function submitBetaFeedback() {
  const feedback = {
    id: `feedback-${Date.now()}`,
    projectId: state.project.id || "",
    projectTitle: state.project.title,
    rating: Number(state.betaFeedbackForm.rating || 0),
    usableEnough: state.betaFeedbackForm.usableEnough,
    feedback: state.betaFeedbackForm.feedback.trim(),
    createdAt: new Date().toISOString(),
    storageMode: shouldUseLocalPersistence() ? "local" : "supabase"
  };
  if (!feedback.rating) {
    setError("Choose a 1-5 rating before submitting feedback.");
    return;
  }
  let savedToSupabase = false;
  if (!shouldUseLocalPersistence() && window.EstateMotionSupabase?.saveBetaFeedback && authUser) {
    try {
      await window.EstateMotionSupabase.saveBetaFeedback(feedback, authUser);
      savedToSupabase = true;
    } catch (error) {
      showToast(`Feedback saved locally; Supabase save failed: ${error.message}`, "error");
    }
  }
  setState((current) => ({
    ...current,
    betaFeedback: [...current.betaFeedback, { ...feedback, storageMode: savedToSupabase ? "supabase" : "local" }],
    betaFeedbackForm: structuredClone(defaultState.betaFeedbackForm)
  }));
  trackEvent("beta_feedback_submit", { rating: feedback.rating, usableEnough: feedback.usableEnough, storageMode: savedToSupabase ? "supabase" : "local" });
  showToast(savedToSupabase ? "Beta feedback saved to Supabase" : "Beta feedback saved locally");
}

async function queueContentPack() {
  const validationError = validateProjectBasics() || validatePhotos() || validateTemplate() || validateMarketingOSFields();
  if (validationError) {
    setError(validationError);
    return;
  }
  if (exportRequiresAccount()) {
    requestExportAuthGate();
    return;
  }
  const photoPersistenceError = await ensurePhotosPersistedForExport();
  if (photoPersistenceError) {
    setError(photoPersistenceError);
    return;
  }
  if (!featureFlags.MOCK_RENDERING) {
    const durableError = await ensureDurableUrlsForLiveRender();
    if (durableError) {
      setError(durableError);
      return;
    }
  }
  const previewManifest = buildExportPayload();
  const manifestError = validatePreRenderManifest(previewManifest, { live: !featureFlags.MOCK_RENDERING });
  if (manifestError) {
    setError(manifestError);
    return;
  }
  const now = new Date().toISOString();
  trackEvent("queue_content_pack", { mockRendering: featureFlags.MOCK_RENDERING, exportTypes: ["vertical-mp4"], templateId: state.selectedTemplateId, contentMode: state.project.contentMode, nicheType: state.project.contentMode?.includes("investor") || state.project.contentMode?.includes("wholesale") ? "investor-wholesale" : "traditional-agent" });
  const jobs = [{
    id: `vertical-mp4-${Date.now()}`,
    packId: "vertical-mp4",
    title: "Professional Listing Video",
    status: "queued",
    format: "9:16",
    createdAt: now,
    updatedAt: now,
    outputName: `${slug(state.project.title)}-professional-listing-video.mp4`,
    progress: 5,
    phase: "Preparing video",
    error: ""
  }];
  setState((current) => ({ ...current, loading: "Preparing video render...", error: "", exportResult: null, renderJobStatus: jobs[0], renderQueue: jobs }));
  logRenderManifest(previewManifest);
  showToast("Video render queued");

  if (!featureFlags.MOCK_RENDERING) {
    startRealRender(jobs);
    return;
  }

  const message = "Video rendering is not connected yet.";
  setState((current) => ({
    ...current,
    loading: "",
    error: message,
    renderJobStatus: { ...jobs[0], status: "failed", phase: "Render worker unavailable", progress: 100, error: message },
    renderQueue: jobs.map((job) => ({ ...job, status: "failed", phase: "Render worker unavailable", progress: 100, error: message }))
  }));
  showToast("Video rendering is not connected yet", "error");
}

async function ensurePhotosPersistedForExport() {
  if (featureFlags.MOCK_SUPABASE || isDemoRoute()) return "";
  if (!authUser) return "Sign in to save your photos and export the finished video.";
  const localPhotos = orderedPhotos().filter((photo) => !photo.durableUrl && !photo.durable_url && isLocalOnlyUrl(photo.uri || photo.objectUrl));
  if (!localPhotos.length) return "";
  setState({ loading: "Saving your photos...", error: "" });
  try {
    await persistTemporaryPhotosAfterAuth();
    await window.EstateMotionSupabase?.saveWorkspace?.(state, authUser);
  } catch (error) {
    return friendlyAuthError(error, "Upload failed. Try again.");
  } finally {
    setState({ loading: "" });
  }
  const stillLocal = orderedPhotos().filter((photo) => !photo.durableUrl && !photo.durable_url && isLocalOnlyUrl(photo.uri || photo.objectUrl));
  return stillLocal.length ? "Upload failed. Try again before exporting the final video." : "";
}

function exportRequiresAccount() {
  return !featureFlags.MOCK_SUPABASE && !authUser && !isDemoRoute();
}

function requestExportAuthGate() {
  setState({
    authMode: "sign-up",
    authReturnScreen: "export",
    pendingExportAfterAuth: true,
    screen: "auth",
    error: ""
  });
}

async function startRealRender(jobs) {
  const durableError = await ensureDurableUrlsForLiveRender();
  if (durableError) {
    const message = durableError;
    setState((current) => ({
      ...current,
      loading: "",
      error: message,
      renderQueue: current.renderQueue.map((job) => job.status === "queued" ? { ...job, status: "failed", error: message, updatedAt: new Date().toISOString() } : job)
    }));
    showToast("Render blocked: durable image URLs required", "error");
    return;
  }
  const manifest = {
    ...buildExportPayload(),
    renderQueue: jobs
  };
  const liveRenderError = validatePreRenderManifest(manifest, { live: true });

  if (liveRenderError) {
    const message = liveRenderError;
    setState((current) => ({
      ...current,
      loading: "",
      error: message,
      renderQueue: current.renderQueue.map((job) => job.status === "queued" ? { ...job, status: "failed", error: message, updatedAt: new Date().toISOString() } : job)
    }));
    showToast("Render failed: public image URLs required", "error");
    return;
  }

  try {
    logRenderManifest(manifest);
    setState((current) => ({
      ...current,
      loading: "Preparing video...",
      renderJobStatus: { ...jobs[0], status: "queued", phase: "Preparing video", progress: 5 },
      renderQueue: current.renderQueue.map((job) => job.status === "queued" ? { ...job, status: "rendering", updatedAt: new Date().toISOString() } : job)
    }));

    // Attach Supabase JWT so /api/render can enforce per-user tier/quota.
    const renderHeaders = { "Content-Type": "application/json" };
    try {
      const sess = await window.EstateMotionSupabase?.getSession?.();
      const token = sess?.access_token || sess?.session?.access_token;
      if (token) renderHeaders.Authorization = `Bearer ${token}`;
    } catch {}

    const response = await fetch(renderApiEndpoint(), {
      method: "POST",
      headers: renderHeaders,
      body: JSON.stringify({ manifest, jobs, requestedFormat: "vertical" })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.status === "failed") {
      throw new Error(actionableRenderError(payload.error || payload.message || `Render worker returned ${response.status}.`));
    }

    if (["queued", "rendering"].includes(payload.status) && payload.jobId) {
      const queuedJob = {
        ...jobs[0],
        jobId: payload.jobId,
        status: payload.status,
        phase: payload.phase || "Rendering scenes",
        progress: Number(payload.progress || 12),
        updatedAt: new Date().toISOString()
      };
      setState((current) => ({
        ...current,
        loading: queuedJob.phase,
        renderJobStatus: queuedJob,
        renderQueue: current.renderQueue.map((job) => ({ ...job, ...queuedJob }))
      }));
      pollRenderJob(payload.jobId);
      return;
    }

    const mp4Url = payload.mp4Url || payload.localMp4Path || "";
    const thumbnailUrl = payload.thumbnailUrl || payload.localThumbnailPath || "";
    if (!mp4Url) {
      throw new Error("Render completed but did not return a downloadable MP4 URL. Check Supabase generated-videos bucket configuration.");
    }
    const completedAt = new Date().toLocaleString();

    setState((current) => ({
      ...current,
      loading: "",
      error: payload.storageWarning || "",
      renderJobStatus: { ...jobs[0], status: "completed", phase: "Ready to download", progress: 100, jobId: payload.jobId || "", mp4Url, thumbnailUrl },
      exportResult: {
        createdAt: completedAt,
        output: mp4Url,
        mp4Url,
        thumbnailUrl,
        storagePath: payload.storagePath || "",
        jobId: payload.jobId || ""
      },
      renderQueue: current.renderQueue.map((job) => job.status === "rendering" ? {
        ...job,
        status: "complete",
        updatedAt: new Date().toISOString(),
        outputPath: payload.storagePath || mp4Url,
        downloadUrl: mp4Url
      } : job)
    }));

    uploadGeneratedRenderManifest();
    showToast(payload.storageWarning ? "Render complete; storage upload needs Supabase service key" : "MP4 render complete", payload.storageWarning ? "info" : "success");
  } catch (error) {
    const message = error.message || "EstateMotion render failed.";
    setState((current) => ({
      ...current,
      loading: "",
      error: message,
      renderQueue: current.renderQueue.map((job) => job.status === "rendering" || job.status === "queued" ? {
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: message
      } : job)
    }));
    showToast("Render failed", "error");
  }
}

async function uploadGeneratedRenderManifest() {
  if (shouldUseLocalPersistence()) return;
  try {
    const payload = JSON.stringify(buildExportPayload(), null, 2);
    const asset = await window.EstateMotionSupabase.uploadTextAsset(`${slug(state.project.title)}-render-manifest.json`, payload, "application/json");
    setState((current) => ({
      ...current,
      exportResult: {
        ...(current.exportResult || {}),
        createdAt: new Date().toLocaleString(),
        output: current.exportResult?.mp4Url || asset.publicUrl,
        manifestUrl: asset.publicUrl,
        manifestStoragePath: asset.path,
        storagePath: current.exportResult?.storagePath || asset.path
      },
      renderQueue: current.renderQueue.map((job) => job.status === "complete" ? { ...job, outputPath: asset.path } : job)
    }));
  } catch (error) {
    setError(error.message || "Generated video storage upload failed.");
  }
}

async function pollRenderJob(jobId, attempt = 0) {
  if (!jobId) return;
  const maxAttempts = 180;
  const delay = Math.min(5000, 1800 + attempt * 120);
  window.setTimeout(async () => {
    try {
      const response = await fetch(`${renderApiEndpoint()}?jobId=${encodeURIComponent(jobId)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.status === "failed") {
        throw new Error(actionableRenderError(payload.error || payload.message || "Render failed while checking status."));
      }
      const normalizedStatus = payload.status === "complete" ? "completed" : payload.status;
      const progress = Number(payload.progress || (normalizedStatus === "completed" ? 100 : 45));
      const mp4Url = payload.mp4Url || payload.localMp4Path || "";
      const thumbnailUrl = payload.thumbnailUrl || payload.localThumbnailPath || "";
      const phase = payload.phase || renderPhaseForProgress(progress, normalizedStatus);
      setState((current) => ({
        ...current,
        loading: normalizedStatus === "completed" ? "" : phase,
        renderJobStatus: {
          ...(current.renderJobStatus || {}),
          ...payload,
          status: normalizedStatus,
          phase,
          progress,
          mp4Url,
          thumbnailUrl,
          jobId
        },
        renderQueue: current.renderQueue.map((job) => job.jobId === jobId || job.packId === "vertical-mp4" ? {
          ...job,
          status: normalizedStatus,
          phase,
          progress,
          updatedAt: new Date().toISOString(),
          downloadUrl: normalizedStatus === "completed" ? mp4Url : "",
          error: ""
        } : job),
        exportResult: normalizedStatus === "completed" && mp4Url ? {
          createdAt: new Date().toLocaleString(),
          output: mp4Url,
          mp4Url,
          thumbnailUrl,
          storagePath: payload.storagePath || "",
          jobId
        } : current.exportResult
      }));
      if (normalizedStatus === "completed") {
        if (!mp4Url) throw new Error("Render completed but no MP4 URL was returned.");
        uploadGeneratedRenderManifest();
        showToast("MP4 render complete", "success");
        return;
      }
      if (attempt >= maxAttempts) throw new Error("Render is taking longer than expected. Check the render worker status and try again.");
      pollRenderJob(jobId, attempt + 1);
    } catch (error) {
      const message = error.message || "Render failed while checking status.";
      setState((current) => ({
        ...current,
        loading: "",
        error: message,
        renderJobStatus: { ...(current.renderJobStatus || {}), status: "failed", phase: "Render failed", progress: 100, error: message, jobId },
        renderQueue: current.renderQueue.map((job) => job.jobId === jobId || job.packId === "vertical-mp4" ? { ...job, status: "failed", phase: "Render failed", progress: 100, error: message } : job)
      }));
      showToast("Render failed", "error");
    }
  }, delay);
}

function renderPhaseForProgress(progress, status) {
  if (status === "completed") return "Ready to download";
  if (progress < 20) return "Preparing video";
  if (progress < 70) return "Rendering scenes";
  if (progress < 95) return "Finalizing MP4";
  return "Preparing download";
}

function advanceRenderQueue(from, to) {
  setState((current) => ({
    ...current,
    renderQueue: current.renderQueue.map((job) => {
      if (job.status !== from) return job;
      return {
        ...job,
        status: to,
        updatedAt: new Date().toISOString(),
        error: to === "failed" ? "Render worker failed or is not configured." : ""
      };
    })
  }));
}

function renderQueuePanel() {
  const status = state.renderJobStatus;
  const mp4Url = state.exportResult?.mp4Url || status?.mp4Url || "";
  const sampleUrl = sampleOutputUrl();
  const disconnected = featureFlags.MOCK_RENDERING || status?.status === "failed" && /not connected|unavailable/i.test(status.error || state.error || "");
  return `
    <section class="panel render-status-panel">
      <div class="section-title"><p>Render status</p><h3>${mp4Url ? "Completed MP4" : disconnected ? "Rendering not connected" : status ? escapeHtml(status.phase || status.status) : "Ready to generate"}</h3></div>
      ${status ? `
        <div class="render-progress-track"><span style="width:${Math.max(4, Math.min(100, Number(status.progress || 0)))}%"></span></div>
        <div class="render-step-list">
          ${["Preparing video", "Uploading assets if needed", "Rendering scenes", "Finalizing MP4", "Ready to download"].map((step) => `<span class="${renderStepActive(step, status)}">${escapeHtml(step)}</span>`).join("")}
        </div>
        ${status.error ? `<div class="state-banner error-state"><strong>Render failed</strong><span>${escapeHtml(publicFacingError(status.error))}</span></div>` : ""}
      ` : `<p class="muted">Click Generate Video to render the real MP4. Download appears only after the worker returns a video URL.</p>`}
      ${mp4Url ? `
        <video class="completed-mp4-player" src="${escapeAttr(mp4Url)}" controls playsinline poster="${escapeAttr(state.exportResult?.thumbnailUrl || status?.thumbnailUrl || "")}"></video>
        <div class="actions single-primary-row">
          <a class="primary button-link" href="${escapeAttr(mp4Url)}" download target="_blank" rel="noreferrer">Download MP4</a>
          <button class="secondary" data-retry-render>Render Again</button>
        </div>
      ` : disconnected ? `
        <div class="state-banner warning-state"><strong>Video rendering is not connected yet.</strong><span>Connect the Remotion worker and set MOCK_RENDERING=false to create real MP4 downloads.</span></div>
        ${sampleUrl ? `<div class="actions single-primary-row"><a class="secondary button-link" href="${escapeAttr(sampleUrl)}" target="_blank" rel="noreferrer">Watch sample output</a><button class="primary" data-retry-render>Retry Render</button></div>` : `<div class="actions single-primary-row"><button class="primary" data-retry-render>Retry Render</button></div>`}
      ` : status?.status === "queued" || status?.status === "rendering" ? `
        <p class="muted">EstateMotion is rendering the final MP4. This can take a few minutes for a 45-60 second listing video.</p>
      ` : `<div class="actions single-primary-row"><button class="primary" data-retry-render>Generate Video</button></div>`}
    </section>
  `;
}

function renderStepActive(step, status = {}) {
  const progress = Number(status.progress || 0);
  const thresholds = {
    "Preparing video": 5,
    "Uploading assets if needed": 15,
    "Rendering scenes": 25,
    "Finalizing MP4": 75,
    "Ready to download": 100
  };
  if (status.status === "failed") return "failed";
  if (progress >= thresholds[step]) return "active";
  return "";
}

function sampleOutputUrl() {
  return "/render-worker/out/openai-motion-director/openai-motion-director.mp4";
}

function renderApiEndpoint() {
  return featureFlags.RENDER_ENDPOINT || "/api/render";
}

async function ensureDurableUrlsForLiveRender() {
  if (featureFlags.MOCK_RENDERING) return "";
  if (featureFlags.MOCK_SUPABASE || !window.EstateMotionSupabase?.enabled?.()) {
    return "Live MP4 rendering requires Supabase Storage. Supabase is unavailable, so this project can only use mock/demo exports. Set MOCK_SUPABASE=false, sign in, and re-upload photos to create durable render URLs.";
  }
  const photos = orderedPhotos();
  const missing = photos.filter((photo) => !photo.durableUrl && !photo.durable_url && !photo.storagePath);
  if (missing.length) {
    const names = missing.slice(0, 3).map((photo) => photo.fileName || photo.id).join(", ");
    return `Live MP4 rendering requires durable Supabase URLs. Re-upload ${missing.length} photo${missing.length === 1 ? "" : "s"}${names ? ` (${names})` : ""} in production mode.`;
  }
  const refreshable = photos.filter((photo) => photo.storagePath && durableUrlNeedsRefresh(photo));
  if (!refreshable.length) return "";
  setState({ loading: "Refreshing signed image URLs for rendering...", error: "" });
  try {
    const refreshed = [];
    for (const photo of refreshable) {
      const bucket = photo.bucket || featureFlags.LISTING_PHOTOS_BUCKET || window.EstateMotionSupabase.listingPhotosBucket?.();
      const asset = await window.EstateMotionSupabase.refreshDurableUrl(photo.storagePath, bucket, signedUrlTtlSecondsForRender());
      refreshed.push({ id: photo.id, ...asset, bucket });
    }
    const refreshedById = new Map(refreshed.map((item) => [item.id, item]));
    setState((current) => ({
      ...current,
      loading: "",
      project: {
        ...current.project,
        photos: current.project.photos.map((photo) => {
          const asset = refreshedById.get(photo.id);
          if (!asset) return photo;
          return {
            ...photo,
            durableUrl: asset.durableUrl,
            durable_url: asset.durableUrl,
            durableUrlExpiresAt: asset.durableUrlExpiresAt || "",
            publicUrl: featureFlags.SUPABASE_STORAGE_PRIVATE ? photo.publicUrl || "" : asset.durableUrl,
            public_url: featureFlags.SUPABASE_STORAGE_PRIVATE ? photo.public_url || "" : asset.durableUrl,
            bucket: asset.bucket || photo.bucket
          };
        })
      }
    }));
    showToast("Signed image URLs refreshed for rendering");
    return "";
  } catch (error) {
    setState({ loading: "" });
    return `Could not refresh Supabase signed image URLs. ${error.message || "Check Storage bucket RLS/select policy and try again."}`;
  }
}

function durableUrlNeedsRefresh(photo) {
  const url = photo.durableUrl || photo.durable_url || "";
  if (!url) return true;
  if (!featureFlags.SUPABASE_STORAGE_PRIVATE && !isLocalOnlyPhotoUrl(url)) return false;
  if (isLocalOnlyPhotoUrl(url)) return true;
  if (isLikelyExpiredImageUrl(url)) return true;
  const expiresAt = Date.parse(photo.durableUrlExpiresAt || "");
  if (!Number.isFinite(expiresAt)) return Boolean(featureFlags.SUPABASE_STORAGE_PRIVATE);
  return expiresAt - Date.now() < 60 * 60 * 1000;
}

function signedUrlTtlSecondsForRender() {
  return Math.max(3600, Number(featureFlags.SUPABASE_SIGNED_URL_TTL_SECONDS || 172800));
}

function buildExportPayload() {
  const copy = aiCopy();
  const sequence = createPipelineSequence();
  const scenes = renderManifestScenes(sequence);
  const music = selectedMusicTrack();
  const orderedManifestPhotos = sequence.scenes.map((scene) => renderPhotoForManifest(scene.photo));
  return {
    app: "EstateMotion",
    createdAt: new Date().toISOString(),
    limitation: "Static MVP export. MP4 rendering may be mocked; this manifest is structured for a Remotion/FFmpeg render worker.",
    project: state.project,
    brandKit: state.brandKit,
    compliance: {
      enabled: state.brandKit.complianceEnabled,
      listingCourtesyOf: state.brandKit.listingCourtesyOf,
      brokerageDisclaimer: state.brandKit.brokerageDisclaimer,
      equalHousing: state.brandKit.equalHousing,
      mlsDisclaimer: state.brandKit.mlsDisclaimer
    },
    marketingOS: {
      contentMode: state.project.contentMode,
      conversionGoal: state.project.conversionGoal || state.project.cta,
      ctaUrl: state.project.ctaUrl,
      qrCodeUrl: state.project.qrCodeUrl,
      sellerPresentationMode: state.project.sellerPresentationMode,
      sellerAssets: sellerTools,
      investorMetrics: state.project.investorMetrics || {},
      investorEstimateSummary: investorEstimateSummary(),
      recommendation: recommendationForCurrentAgent()
    },
    featureFlags,
    renderQueue: state.renderQueue,
    template: selectedTemplate(),
    stylePack: templatePipelineId(),
    reelTheme: selectedReelTheme(),
    formats: [
      { id: "vertical", label: "9:16 Reels/TikTok/Shorts", width: 1080, height: 1920, branded: true },
      { id: "square", label: "1:1 Instagram", width: 1080, height: 1080, branded: true },
      { id: "wide", label: "16:9 YouTube/web", width: 1920, height: 1080, branded: true },
      { id: "mls", label: "MLS-compliant", width: 1920, height: 1080, branded: false }
    ],
    creative: {
      textAnimation: state.project.textAnimation,
      musicMood: state.project.musicMood,
      outroVariation: state.project.outroVariation,
      thumbnailPreset: state.project.thumbnailPreset,
      reelVariations: state.project.reelVariations,
      musicTrack: music,
      motionSystem: selectedMotionSystem(),
      beatSync: beatSyncPlan(scenes, music)
    },
    music,
    topFeatures: topFeatures(),
    orderedPhotos: orderedManifestPhotos,
    uploadedPhotoIntegrity: orderedManifestPhotos.map((photo) => ({
      photoId: photo.id,
      fileName: photo.fileName,
      imageUrl: photo.imageUrl,
      storagePath: photo.storagePath || "",
      size: photo.size || 0
    })),
    scenes,
    propertyTourSequence: sequence,
    exportOptimization: window.EstateMotionReel?.exportOptimization?.verticalReelExport ? window.EstateMotionReel.exportOptimization.verticalReelExport() : null,
    copy,
    contentPack: contentPack(),
    renderPlan: [
      "Load ordered photos",
      "Add intro hook card",
      `Apply ${selectedTemplate().motionSpeed} Ken Burns pan/zoom`,
      `Apply ${selectedTemplate().transitionStyle} transitions`,
      "Add feature cards and property facts",
      "Add personal brand end card",
      "Export MP4, thumbnail, caption, hashtags"
    ]
  };
}

function renderManifestScenes(sequence = createPipelineSequence()) {
  const scenes = sequence.scenes || [];
  const copy = aiCopy();
  const captionByScene = new Map(pipelineCaptions(sequence).map((item) => [item.sceneId, item.caption]));
  let beatCursor = 0;
  const music = selectedMusicTrack();
  return scenes.map((scene, index) => {
    const photo = scene.photo;
    const motion = motionPlanForPhoto(photo, index);
    const duration = Number(scene.duration || motion.duration);
    const imageUrl = photoRenderUrl(photo);
    const durableUrl = photoDurableUrl(photo);
    const publicUrl = photo.publicUrl || photo.public_url || (!featureFlags.SUPABASE_STORAGE_PRIVATE ? durableUrl : "");
    const marketingOverlay = modeSpecificOverlay(scene, index, scenes.length);
    const sceneManifest = {
      order: index + 1,
      type: "photo",
      photoId: photo.id,
      fileName: photo.fileName,
      imageUrl,
      durableUrl,
      durable_url: durableUrl,
      publicUrl,
      public_url: publicUrl,
      sourceImageUrl: photoRenderUrl(photo),
      objectUrl: photo.objectUrl || "",
      durableUrlExpiresAt: photo.durableUrlExpiresAt || "",
      bucket: photo.bucket || featureFlags.LISTING_PHOTOS_BUCKET || "",
      storagePath: photo.storagePath || "",
      sceneType: motion.sceneType,
      confidence: motion.confidence,
      suggestedCorrections: sceneSuggestions(photo),
      duration,
      motionStyle: motion.motionStyle || pipelineTemplateConfig().motionStyle,
      renderMotion: motion.renderMotion || motion.motionStyle || pipelineTemplateConfig().motionStyle,
      depthModel: motion.depthModel,
      transition: motion.transition || pipelineTemplateConfig().transitionStyle,
      beatMarker: motion.beatMarker,
      beatStart: Number(beatCursor.toFixed(2)),
      beatCut: Number((beatCursor + duration).toFixed(2)),
      musicTrackId: music.id,
      overlayText: marketingOverlay.headline || (index === 0 ? (sequence.intro?.caption || copy.hook) : (index === scenes.length - 1 ? (sequence.outro?.caption || captionByScene.get(scene.id) || motion.overlayText) : (captionByScene.get(scene.id) || motion.overlayText))),
      marketingOverlay,
      featureCard: topFeatures()[index % Math.max(1, topFeatures().length)] || "",
      branding: index === scenes.length - 1 ? "Personal brand end card" : "Subtle lower-third safe area",
      cta: index === scenes.length - 1 ? (sequence.outro?.caption || state.project.cta) : "",
      complianceFooter: state.brandKit.complianceEnabled ? state.brandKit.listingCourtesyOf : "",
      realismGuardrail: motion.realismGuardrail
    };
    beatCursor += duration;
    return sceneManifest;
  });
}

function renderPhotoForManifest(photo) {
  const durableUrl = photoDurableUrl(photo);
  const previewUrl = photo.uri || photo.objectUrl || durableUrl || "";
  const publicUrl = photo.publicUrl || photo.public_url || (!featureFlags.SUPABASE_STORAGE_PRIVATE ? durableUrl : "");
  const renderUrl = durableUrl || previewUrl;
  return {
    ...photo,
    uri: previewUrl,
    publicUrl,
    public_url: publicUrl,
    durableUrl,
    durable_url: durableUrl,
    durableUrlExpiresAt: photo.durableUrlExpiresAt || "",
    imageUrl: renderUrl
  };
}

function photoRenderUrl(photo) {
  const durableUrl = photoDurableUrl(photo);
  if (!featureFlags.MOCK_RENDERING && durableUrl) return durableUrl;
  return photo.uri || photo.objectUrl || durableUrl || photo.publicUrl || photo.public_url || "";
}

function photoDurableUrl(photo) {
  return photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || "";
}

function isLocalOnlyPhotoUrl(url) {
  const value = String(url || "");
  return value.startsWith("blob:") || value.startsWith("data:");
}

function validateLiveRenderPhotoUrls(photos) {
  if (featureFlags.MOCK_RENDERING) return "";
  const localOnly = photos.filter((photo) => isLocalOnlyPhotoUrl(photoRenderUrl(photo)));
  if (!localOnly.length) return "";
  const names = localOnly.slice(0, 3).map((photo) => photo.fileName || photo.id || "unnamed photo").join(", ");
  return `Live MP4 rendering requires Supabase/public image URLs. ${localOnly.length} photo${localOnly.length === 1 ? "" : "s"} still use blob/data URLs${names ? ` (${names})` : ""}. Switch to Supabase mode and re-upload photos, or set MOCK_RENDERING=true for local demo exports.`;
}

function validatePreRenderManifest(manifest, options = {}) {
  if (!manifest || !Array.isArray(manifest.scenes) || !manifest.scenes.length) {
    return "Render manifest is missing photo scenes. Upload listing photos and build the reel again.";
  }
  const uploadedPhotos = new Map(orderedPhotos().map((photo) => [photo.id, photo]));
  const problems = [];
  manifest.scenes.forEach((scene, index) => {
    if (isIntentionalCardScene(scene)) return;
    const label = scene.fileName || `scene ${index + 1}`;
    if (!scene.photoId || !uploadedPhotos.has(scene.photoId)) {
      problems.push(`${label} is not linked to an uploaded project photo.`);
      return;
    }
    const originalPhoto = uploadedPhotos.get(scene.photoId);
    const originalUrl = photoRenderUrl(originalPhoto);
    const sceneUrl = scene.durableUrl || scene.durable_url || scene.publicUrl || scene.public_url || scene.imageUrl || "";
    if (!sceneUrl) {
      problems.push(`${label} is missing an image URL.`);
      return;
    }
    if (options.live && !(scene.durableUrl || scene.durable_url)) {
      problems.push(`${label} is missing durableUrl. Re-upload the photo to Supabase Storage before live rendering.`);
      return;
    }
    if (options.live && isLocalOnlyPhotoUrl(sceneUrl)) {
      problems.push(`${label} still uses a browser-only preview URL. Re-upload in Supabase mode before live MP4 rendering.`);
    }
    if (isUnsupportedRenderImageUrl(sceneUrl)) {
      problems.push(`${label} uses an unsupported image format. Use JPG, PNG, or WebP.`);
    }
    if (isLikelyExpiredImageUrl(sceneUrl)) {
      problems.push(`${label} appears to use an expired signed image URL. Re-upload or refresh the Supabase public URL.`);
    }
    if (originalUrl && normalizeUrlForCompare(sceneUrl) !== normalizeUrlForCompare(originalUrl) && normalizeUrlForCompare(sceneUrl) !== normalizeUrlForCompare(originalPhoto.publicUrl || originalPhoto.public_url || "")) {
      problems.push(`${label} does not match the uploaded image stored in this project.`);
    }
  });
  if (!problems.length) return "";
  return `Render preflight failed: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` ${problems.length - 3} more issue${problems.length - 3 === 1 ? "" : "s"} found.` : ""}`;
}

function isIntentionalCardScene(scene) {
  return ["title", "intro", "outro", "card", "stats"].includes(String(scene.type || "").toLowerCase());
}

function isUnsupportedRenderImageUrl(url) {
  const value = String(url || "").toLowerCase();
  if (value.startsWith("data:")) {
    return !value.startsWith("data:image/jpeg") && !value.startsWith("data:image/jpg") && !value.startsWith("data:image/png") && !value.startsWith("data:image/webp");
  }
  const path = value.split("?")[0];
  return /\.(heic|heif|tif|tiff|bmp|svg|gif)$/i.test(path);
}

function isLikelyExpiredImageUrl(url) {
  try {
    const parsed = new URL(String(url), window.location.href);
    const rawExpiry = parsed.searchParams.get("expires") || parsed.searchParams.get("expires_at") || parsed.searchParams.get("expiry") || parsed.searchParams.get("exp");
    if (!rawExpiry) return false;
    const numeric = Number(rawExpiry);
    const expiresAt = Number.isFinite(numeric)
      ? new Date(numeric < 10000000000 ? numeric * 1000 : numeric)
      : new Date(rawExpiry);
    return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
  } catch {
    return false;
  }
}

function normalizeUrlForCompare(url) {
  return String(url || "").trim();
}

function logRenderManifest(manifest) {
  if (!devRenderLoggingEnabled()) return;
  window.ESTATEMOTION_LAST_RENDER_MANIFEST = manifest;
  console.info("[EstateMotion] Render manifest preflight passed. Inspect window.ESTATEMOTION_LAST_RENDER_MANIFEST for the exact uploaded images sent to rendering.", manifest);
}

function devRenderLoggingEnabled() {
  const params = new URLSearchParams(window.location.search);
  return params.get("DEBUG_RENDER") === "true" || ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

function actionableRenderError(message) {
  const text = String(message || "");
  if (/expired|403|forbidden|not authorized|signature/i.test(text)) {
    return `${text} The render worker could not access one or more image URLs. Re-upload photos to Supabase Storage and render again.`;
  }
  if (/fetch|network|ENOTFOUND|timeout|timed out/i.test(text)) {
    return `${text} Check RENDER_ENDPOINT/RENDER_WORKER_URL and confirm the render worker is online.`;
  }
  if (/image|url|404|not found/i.test(text)) {
    return `${text} Confirm every scene image URL is public and still available.`;
  }
  return `${text} Check the render worker logs and retry after confirming Supabase image URLs are accessible.`;
}

function beatSyncPlan(scenes, music = selectedMusicTrack()) {
  const totalDuration = scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
  return {
    musicMood: state.project.musicMood,
    musicTrack: music,
    audioConfigured: Boolean(music.url),
    fallback: music.fallback,
    pacingSystem: selectedMotionSystem().tempo,
    totalDuration: Number(totalDuration.toFixed(2)),
    markers: scenes.map((scene, index) => ({
      time: Number((scene.beatStart ?? scenes.slice(0, index).reduce((sum, item) => sum + Number(item.duration || 0), 0)).toFixed(2)),
      cutAt: Number(Number(scene.beatCut ?? (Number(scene.beatStart || 0) + Number(scene.duration || 0))).toFixed(2)),
      label: scene.beatMarker,
      musicTrackId: scene.musicTrackId || music.id,
      transition: scene.transition
    }))
  };
}

function buildPreviewHtml(payload) {
  const first = payload.orderedPhotos[0] ?? demoPhotos[0];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(payload.project.title)} Preview</title><style>body{margin:0;font-family:Arial,sans-serif;background:#f8f6f1;color:#101113;padding:24px}.reel{position:relative;max-width:390px;aspect-ratio:9/16;margin:auto;border:8px solid ${payload.template.accentColor};border-radius:28px;overflow:hidden;background:#111}.reel img{width:100%;height:100%;object-fit:cover}.shade{position:absolute;inset:0;background:linear-gradient(transparent,rgba(0,0,0,.78))}.copy{position:absolute;inset:auto 18px 18px;color:white}.card{background:rgba(255,255,255,.94);color:#111;border-left:4px solid ${payload.template.accentColor};border-radius:8px;padding:14px}h1{font-size:32px;line-height:.98}</style></head><body><div class="reel"><img src="${first.uri}"><div class="shade"></div><div class="copy"><h1>${escapeHtml(payload.copy.hook)}</h1><p>${payload.project.price} - ${payload.project.beds} BD - ${payload.project.baths} BA</p><div class="card"><strong>${escapeHtml(payload.brandKit.name)}</strong><br>${escapeHtml(payload.brandKit.brokerage)}<br><b>${escapeHtml(payload.brandKit.ctaText)}</b></div></div></div><pre>${escapeHtml(JSON.stringify(payload.copy, null, 2))}</pre></body></html>`;
}

function agentStrip() {
  const headshot = state.brandKit.headshotUri ? `<img class="agent-headshot" src="${escapeAttr(state.brandKit.headshotUri)}" alt="">` : "";
  const logo = state.brandKit.logoUri ? `<img class="agent-logo" src="${escapeAttr(state.brandKit.logoUri)}" alt="">` : "";
  return `
    <div class="agent-strip">
      ${headshot}
      <span>
        <strong>${escapeHtml(state.brandKit.name)}</strong>
        <small>${escapeHtml(state.brandKit.brokerage)}</small>
        <b>${escapeHtml(state.brandKit.ctaText)}</b>
      </span>
      ${logo}
    </div>
  `;
}

function outroBlock() {
  if (state.project.outroVariation === "Brokerage logo only") {
    return `
      <div class="agent-strip brokerage-only">
        <span>
          <strong>${escapeHtml(state.brandKit.brokerage)}</strong>
          <small>${escapeHtml(state.brandKit.website)}</small>
          <b>${escapeHtml(state.project.cta)}</b>
        </span>
      </div>
    `;
  }
  if (state.project.outroVariation === "Social follow CTA") {
    return `
      <div class="agent-strip">
        <span>
          <strong>Follow ${escapeHtml(state.brandKit.instagram || state.brandKit.name)}</strong>
          <small>${escapeHtml(state.brandKit.brokerage)}</small>
          <b>${escapeHtml(state.project.cta)}</b>
        </span>
      </div>
    `;
  }
  return agentStrip();
}

function complianceBlock() {
  if (!state.brandKit.complianceEnabled) return `<p class="muted">Compliance fields are disabled for this export.</p>`;
  return `
    <div class="compliance-lines">
      <p>${escapeHtml(state.brandKit.listingCourtesyOf)}</p>
      <p>${escapeHtml(state.brandKit.brokerageDisclaimer)}</p>
      <p>${state.brandKit.equalHousing ? "Equal Housing Opportunity" : "Equal Housing Opportunity hidden"}</p>
      <p>${escapeHtml(state.brandKit.mlsDisclaimer)}</p>
    </div>
  `;
}

function renderPricing() {
  renderLayout(`
    <div class="screen-title"><p class="eyebrow">Pricing & credits</p><h2>Plans for every agent team</h2><p>Stripe is mocked locally, but the plan structure and credit logic are ready for checkout wiring.</p></div>
    <section class="pricing-grid">
      ${pricingCard("Free trial", "$0", "10 credits", "Try listing reels with mock rendering.", "Current")}
      ${pricingCard("Pay-per-export", "$9", "1 content pack", "Great for occasional listings.", "Buy export")}
      ${pricingCard("Monthly Pro", "$49/mo", "40 credits", "For active agents posting weekly.", "Start Pro")}
      ${pricingCard("Brokerage plan", "Custom", "Team credits", "Admin billing, templates, and compliance defaults.", "Contact sales")}
    </section>
    <section class="panel">
      <div class="section-title"><p>Stripe mode</p><h3>${featureFlags.MOCK_STRIPE ? "Mocked" : "Live"}</h3></div>
      <p class="muted">${featureFlags.MOCK_STRIPE ? "Buttons do not create Stripe Checkout sessions yet." : "Connect these buttons to your Stripe Checkout endpoint."}</p>
    </section>
  `);
  bindPricingTracking();
}

function renderAnalytics() {
  const summary = analyticsSummary();
  const pricingEvents = state.analyticsEvents.filter((event) => event.type === "pricing_click");
  const recent = state.analyticsEvents.slice(-8).reverse();
  renderLayout(`
    <div class="screen-title"><p class="eyebrow">Local analytics</p><h2>Founder validation dashboard</h2><p>All analytics are stored locally in this browser for demo validation.</p></div>
    <section class="analytics-grid">
      ${metricCard("Total visits", summary.visits)}
      ${metricCard("Total leads", summary.leads)}
      ${metricCard("Conversion rate", `${summary.conversionRate}%`)}
      ${metricCard("Most clicked pricing option", summary.mostClicked)}
      ${metricCard("Export intent count", summary.exportIntent)}
      ${metricCard("Most used template", summary.mostUsedTemplate)}
      ${metricCard("Most used hook", summary.mostUsedHook)}
      ${metricCard("Most exported style", summary.mostExportedStyle)}
      ${metricCard("Top content mode", summary.mostUsedContentMode)}
    </section>
    <section class="panel recommendation-card"><strong>Recommendation engine</strong><span>${escapeHtml(summary.recommendation)}</span></section>
    <section class="panel">
      <div class="section-title"><p>Pricing clicks</p><h3>${pricingEvents.length} total</h3></div>
      ${pricingEvents.length ? pricingBreakdown() : emptyState("No pricing clicks yet", "Click pricing test cards on the Demo page to collect interest signals.")}
    </section>
    <section class="panel">
      <div class="section-title"><p>Recent events</p><h3>Last ${recent.length}</h3></div>
      ${recent.length ? recent.map((event) => `<div class="event-row"><span><strong>${escapeHtml(event.type)}</strong><small>${new Date(event.createdAt).toLocaleString()}</small></span><code>${escapeHtml(JSON.stringify(event.metadata))}</code></div>`).join("") : emptyState("No analytics yet", "Visit /demo and interact with pricing or exports to collect events.")}
      <div class="actions">
        <button class="secondary" data-export-analytics>Export analytics JSON</button>
        <button class="danger" data-clear-analytics>Clear analytics</button>
      </div>
    </section>
  `);
  document.querySelector("[data-export-analytics]").addEventListener("click", () => {
    downloadFile("estatemotion-local-analytics.json", "application/json", JSON.stringify({ summary, events: state.analyticsEvents, leads: state.leads }, null, 2));
    showToast("Analytics JSON exported");
  });
  document.querySelector("[data-clear-analytics]").addEventListener("click", () => {
    setState((current) => ({ ...current, analyticsEvents: [] }));
    showToast("Analytics cleared");
  });
}

function metricCard(label, value) {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function pricingBreakdown() {
  const counts = state.analyticsEvents.filter((event) => event.type === "pricing_click").reduce((all, event) => {
    const plan = event.metadata.plan ?? "Unknown";
    all[plan] = (all[plan] ?? 0) + 1;
    return all;
  }, {});
  return Object.entries(counts).map(([plan, count]) => `<div class="queue-row"><span>${escapeHtml(plan)}</span><b>${count}</b></div>`).join("");
}

function pricingCard(name, price, credits, copy, cta) {
  return `
    <article class="pricing-card">
      <p>${name}</p>
      <h3>${price}</h3>
      <strong>${credits}</strong>
      <span>${copy}</span>
      <button class="${cta === "Current" ? "secondary" : "primary"}" data-pricing-plan="${escapeAttr(name)}">${cta}</button>
    </article>
  `;
}

function bindPricingTracking() {
  document.querySelectorAll("[data-pricing-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      trackEvent("pricing_click", { plan: button.dataset.pricingPlan });
      showToast(`${button.dataset.pricingPlan} pricing interest tracked`);
    });
  });
}

function validateLead() {
  const form = state.earlyAccessForm;
  if (!form.name.trim()) return "Name is required for early access.";
  if (!form.email.trim() || !form.email.includes("@")) return "A valid email is required.";
  if (!form.brokerage.trim()) return "Brokerage is required.";
  return "";
}

function submitLead() {
  const error = validateLead();
  if (error) {
    setError(error);
    return;
  }
  const lead = {
    id: `lead-${Date.now()}`,
    submittedAt: new Date().toISOString(),
    ...state.earlyAccessForm
  };
  setState((current) => ({
    ...current,
    error: "",
    leads: [...current.leads, lead],
    earlyAccessForm: structuredClone(defaultState.earlyAccessForm)
  }));
  trackEvent("early_access_submit", { city: lead.city, brokerage: lead.brokerage, monthlyListings: lead.monthlyListings });
  showToast("Early access request saved locally");
}

function exportLeadsCsv() {
  if (!state.leads.length) {
    setError("No early-access submissions to export yet.");
    return;
  }
  const headers = ["submittedAt", "name", "email", "brokerage", "city", "monthlyListings", "biggestProblem"];
  const rows = state.leads.map((lead) => headers.map((key) => csvCell(lead[key])).join(","));
  downloadFile("estatemotion-early-access-leads.csv", "text/csv", `${headers.join(",")}\n${rows.join("\n")}`);
  showToast("Early-access CSV exported");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadFile(name, type, body) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, successMessage) {
  try {
    if (!navigator.clipboard) {
      throw new Error("Clipboard unavailable");
    }
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    downloadFile(`${slug(successMessage)}.txt`, "text/plain", text);
    showToast("Clipboard unavailable, downloaded text instead");
  }
}

function emptyState(title, body) {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(body)}</span>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}

function slug(value) {
  return String(value || "estatemotion-export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function render() {
  if (isProtectedAppRoute() && !featureFlags.MOCK_SUPABASE && (state.authStatus === "checking" || state.authStatus === "loading")) {
    renderLayout(`<section class="panel elevated"><div class="state-banner loading-state"><span class="spinner"></span><strong>Connecting to Supabase...</strong></div></section>`);
    return;
  }
  const screens = {
    demo: renderDemoLandingPremium,
    beta: renderBetaLanding,
    auth: renderAuth,
    dashboard: renderDashboard,
    onboarding: renderOnboarding,
    create: renderCreate,
    upload: renderUpload,
    details: renderDetails,
    template: renderTemplate,
    processing: renderProcessing,
    preview: renderPreview,
    edit: renderEdit,
    brand: renderBrand,
    pricing: renderPricing,
    analytics: renderAnalytics,
    export: renderExport
  };
  (screens[state.screen] ?? renderDashboard)();
}

function listingVideoTemplates() {
  return [
    {
      id: "modern-luxury",
      label: "Cinematic Luxury",
      description: "Elegant cinematic motion built for premium listings and luxury branding.",
      bestFor: "Luxury listings / premium agents",
      badge: "Recommended",
      previewImage: "https://images.unsplash.com/photo-1600607687644-c7171b42498f?auto=format&fit=crop&w=1200&q=80",
      previewTone: "Dramatic exterior, slow push-in, warm gold titles",
      motion: "Slow zooms · Light leaks · Editorial lower thirds"
    },
    {
      id: "viral-fast-cut",
      label: "Modern Social",
      description: "Fast-paced modern edits optimized for social media engagement.",
      bestFor: "Instagram / TikTok / lead gen",
      badge: "Social-ready",
      previewImage: "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1200&q=80",
      previewTone: "Punchy room cuts, bold captions, mobile-first rhythm",
      motion: "Fast cuts · Speed ramps · Bold stat cards"
    },
    {
      id: "mls-clean",
      label: "MLS Clean",
      description: "Professional, MLS-safe listing videos with clean transitions.",
      bestFor: "MLS / standard listings",
      badge: "Clean",
      previewImage: "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1200&q=80",
      previewTone: "Simple property tour, factual overlays, restrained motion",
      motion: "Clean fades · Stat cards · Unbranded option"
    },
    {
      id: "investor-wholesale",
      label: "Investor Property Tour",
      description: "Straightforward property walkthroughs for investors and deal presentations.",
      bestFor: "Investors / wholesalers",
      badge: "Deal-focused",
      previewImage: "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1200&q=80",
      previewTone: "Direct walkthrough, practical captions, clear property facts",
      motion: "Steady pans · Detail cards · Investor pacing"
    }
  ];
}

function renderLayout(content) {
  const navItems = [
    { screen: "upload", label: "Photos" },
    { screen: "processing", label: "Order" },
    { screen: "template", label: "Style" },
    { screen: "preview", label: "Preview" },
    { screen: "export", label: "Export" }
  ];
  const step = navItems.findIndex((item) => item.screen === state.screen) + 1;
  const publicLanding = state.screen === "demo" || isDemoRoute();
  app.innerHTML = `
    <main class="app listing-video-app">
      <header class="topbar video-topbar">
        <button class="brand video-brand" data-home>
          <span>EM</span>
          <b>EstateMotion</b>
        </button>
        ${publicLanding ? `<nav class="landing-nav"><button data-scroll-sample>Watch Sample</button><button class="primary" data-nav="upload">Get My Free Video</button></nav>` : `<div class="top-progress video-progress" aria-label="Listing video creation progress">
          ${navItems.map((item, index) => `<button class="${state.screen === item.screen ? "active" : ""} ${step > index + 1 ? "complete" : ""}" data-nav="${item.screen}"><span>${index + 1}</span><b>${item.label}</b></button>`).join("")}
        </div>`}
        <div class="top-actions ${publicLanding ? "landing-actions-hidden" : ""}">
          ${!featureFlags.MOCK_SUPABASE && authUser ? `<span class="status-dot live">Signed in</span><button class="reset-demo" data-sign-out>Sign out</button>` : ""}
          ${!featureFlags.MOCK_SUPABASE && !authUser ? `<button class="reset-demo auth-entry" data-auth-entry="sign-in">Sign in</button><button class="reset-demo auth-entry primary-lite" data-auth-entry="sign-up">Start free trial</button>` : ""}
        </div>
      </header>
      <section class="screen video-screen">
        ${state.error ? `<div class="state-banner error-state"><strong>Needs attention</strong><span>${escapeHtml(publicFacingError(state.error))}</span></div>` : ""}
        ${state.loading ? `<div class="state-banner loading-state"><span class="spinner"></span><strong>${escapeHtml(state.loading)}</strong></div>` : ""}
        ${content}
      </section>
      <nav class="bottom-nav">
        ${navItems.map((item) => `<button class="${state.screen === item.screen ? "active" : ""}" data-nav="${item.screen}">${item.label}</button>`).join("")}
      </nav>
      <div class="toast-stack">${state.toasts.map((toast) => `<div class="toast ${toast.type}">${escapeHtml(toast.message)}</div>`).join("")}</div>
    </main>
  `;
  document.querySelector("[data-home]")?.addEventListener("click", () => navigate(isDemoRoute() ? "demo" : "dashboard"));
  document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.nav)));
  document.querySelector("[data-sign-out]")?.addEventListener("click", signOut);
  document.querySelectorAll("[data-auth-entry]").forEach((button) => button.addEventListener("click", () => {
    setState({ authMode: button.dataset.authEntry, authReturnScreen: state.screen === "auth" ? state.authReturnScreen : state.screen, screen: "auth", error: "" });
  }));
  bindInputs();
}

function publicFacingError(message = "") {
  const text = String(message || "");
  if (/supabase|mock|openai|api\/|schema|rls|vercel|environment|render worker|durable|blob:|data url|storage bucket/i.test(text)) {
    if (/sign in|account|auth/i.test(text)) return "Create or sign in to your account to save photos and export the finished video.";
    if (/upload|photo|storage|durable|blob/i.test(text)) return "We could not save your photos for final export. Try again, or use the sample listing.";
    if (/render|worker|mp4/i.test(text)) return "The final video could not be created yet. Check your photos and try exporting again.";
    return "This action is not available right now. Try again or continue with the sample listing.";
  }
  return text;
}

function maybeStartOnboarding() {
  const route = routeFromUrl();
  if (route) {
    state.screen = route;
    saveState();
    return;
  }
  if (["onboarding", "details", "edit", "brand", "pricing", "analytics", "create"].includes(state.screen)) {
    state.screen = "dashboard";
    saveState();
  }
}

function renderDashboard() {
  renderLayout(`
    <section class="video-hero app-command-hero reveal-on-scroll">
      <div class="video-hero-copy">
        <p class="eyebrow">Listing photos in. Pro video out.</p>
        <h2>Build a finished listing video in minutes.</h2>
        <p>Upload the photos you already have. EstateMotion creates the property story, adds cinematic motion, and prepares every social format.</p>
        <div class="actions">
          <button class="primary" data-start-video>Get My Free Video</button>
          <button class="secondary" data-watch-sample>Watch sample</button>
        </div>
        ${trustBadgeRow()}
      </div>
      <div class="video-hero-preview">
        ${professionalPhonePreview(demoPhotos[0], "Cinematic Luxury")}
      </div>
    </section>
    <section class="video-step-grid reveal-on-scroll">
      ${["Upload listing photos", "Choose a video style", "Preview your reel", "Export social formats"].map((item, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(item)}</strong></article>`).join("")}
    </section>
  `);
  document.querySelector("[data-start-video]").addEventListener("click", () => navigate("upload"));
  document.querySelector("[data-watch-sample]").addEventListener("click", () => navigate("demo"));
}

function renderDemoLandingPremium() {
  trackDemoVisitOnce();
  renderLayout(`
    <section class="video-landing-hero landing-cinematic-hero reveal-on-scroll">
      <div class="video-hero-copy">
        <p class="eyebrow">EstateMotion for real estate agents</p>
        <h2>Professional Listing Videos From Your Photos</h2>
        <p>Upload your listing photos and get a cinematic real estate video ready to post in minutes.</p>
        <div class="actions">
          <button class="primary" data-nav="upload">Get My Free Video</button>
          <button class="secondary" data-scroll-sample>Watch Sample</button>
        </div>
        ${trustBadgeRow()}
        ${reviewStrip()}
      </div>
      <div class="video-hero-preview">
        <div class="hero-video-orbit">${professionalPhonePreview(demoPhotos[0], "Sample listing video")}</div>
      </div>
    </section>
    <section class="video-section reveal-on-scroll">
      <div class="section-title centered"><p>How it works</p><h3>Upload photos. Get a pro video.</h3></div>
      <div class="video-step-grid">
        <article><span>01</span><strong>Upload listing photos</strong><small>Select the property photos you already use for MLS and social.</small></article>
        <article><span>02</span><strong>EstateMotion builds the reel</strong><small>Scenes are ordered into a polished property tour with cinematic motion.</small></article>
        <article><span>03</span><strong>Download everywhere</strong><small>Export vertical, square, wide, branded, and clean versions.</small></article>
      </div>
    </section>
    <section class="video-section proof-section reveal-on-scroll">
      <div class="section-title centered"><p>Proof</p><h3>Designed to make ordinary listing photos feel professionally edited.</h3></div>
      <div class="proof-stat-grid">
        <article><strong>8-25</strong><span>photos to a finished listing story</span></article>
        <article><strong>5 min</strong><span>from upload to preview</span></article>
        <article><strong>4.9</strong><span>agent demo rating</span></article>
      </div>
      <div class="agent-avatar-row" aria-label="Agent reviewers">
        ${agentAvatars()}
        <span>Trusted by agents building better listing launches</span>
      </div>
    </section>
    <section class="video-section reveal-on-scroll" id="sampleOutput">
      <div class="section-title centered"><p>Sample outputs</p><h3>Three premium styles for real listings.</h3></div>
      <div class="sample-output-grid">
        ${listingVideoTemplates().slice(0, 3).map((template, index) => `<article>${professionalPhonePreview(demoPhotos[index] || demoPhotos[0], template.label)}<strong>${escapeHtml(template.label)}</strong><small>${escapeHtml(template.description)}</small></article>`).join("")}
      </div>
    </section>
    <section class="video-section reveal-on-scroll">
      <div class="section-title centered"><p>Why agents use it</p><h3>Pro video without a videographer.</h3></div>
      <div class="video-feature-grid">
        ${[
          ["Cinematic motion", "Still listing photos get smooth camera movement and premium transitions."],
          ["Brand-ready", "Your name, brokerage, CTA, and clean end card stay consistent."],
          ["Social-native", "Built for Reels, TikTok, Shorts, Stories, and feed posts."],
          ["Authentic visuals", "No fake rooms, fake views, or invented property features."]
        ].map(([title, body]) => `<article><strong>${escapeHtml(title)}</strong><small>${escapeHtml(body)}</small></article>`).join("")}
      </div>
    </section>
    <section class="video-section testimonials-section reveal-on-scroll">
      <div class="section-title centered"><p>What agents say</p><h3>“This feels easier than hiring an editor.”</h3></div>
      <div class="testimonial-grid">
        ${testimonialCard("★★★★★", "I understood it instantly. Upload photos, choose a style, export a reel.", "Scottsdale listing agent")}
        ${testimonialCard("★★★★★", "The sample output feels polished enough to show sellers at a listing appointment.", "Phoenix team lead")}
        ${testimonialCard("★★★★★", "This is the kind of tool that makes an agent look bigger online.", "Brokerage partner")}
      </div>
    </section>
    <section class="video-section reveal-on-scroll">
      <div class="section-title centered"><p>Simple plans</p><h3>Built around listing volume.</h3></div>
      <div class="pricing-grid video-pricing">
        ${pricingCard("Starter", "$19/video", "Pay per listing", "For agents launching one polished listing at a time.", "Starter")}
        ${pricingCard("Growth", "$49/month", "More monthly videos", "For agents who post consistently and want brand momentum.", "Growth")}
        ${pricingCard("Pro", "Team plan", "Brokerage volume", "For teams and brokerages standardizing listing media.", "Pro")}
      </div>
    </section>
    <section class="video-section faq-section reveal-on-scroll">
      <div class="section-title centered"><p>FAQ</p><h3>Built around real listing photos.</h3></div>
      <div class="faq-grid">
        ${faqItem("Does it use my real photos?", "Yes. EstateMotion builds motion and overlays from uploaded listing photos only.")}
        ${faqItem("Can I export unbranded videos?", "Yes. The export architecture supports branded and unbranded variants.")}
        ${faqItem("Is it MLS-safe?", "MLS Clean mode uses factual captions, restrained graphics, and clean formatting.")}
        ${faqItem("How long does rendering take?", "Most previews are ready in minutes, with final exports queued from your finished video plan.")}
      </div>
    </section>
    <section class="video-final-cta reveal-on-scroll">
      <h3>Create a professional video from your listing photos.</h3>
      <button class="primary" data-nav="upload">Get My Free Video</button>
    </section>
  `);
  document.querySelectorAll("[data-scroll-sample]").forEach((button) => button.addEventListener("click", () => document.querySelector("#sampleOutput")?.scrollIntoView({ behavior: "smooth" })));
}

function trustBadgeRow() {
  return `<div class="video-proof-row trust-badge-row">
    <span>Uses your real photos</span>
    <span>No fake property features</span>
    <span>MLS-safe style option</span>
    <span>Brand kit included</span>
  </div>`;
}

function reviewStrip() {
  return `<div class="review-strip">
    <strong>★★★★★</strong>
    <span>“Looks like a professional editor touched it.”</span>
  </div>`;
}

function agentAvatars() {
  const initials = ["TM", "AZ", "SC", "PH"];
  return initials.map((initial, index) => `<i style="--avatar-index:${index}">${initial}</i>`).join("");
}

function testimonialCard(stars, quote, name) {
  return `<article><strong>${escapeHtml(stars)}</strong><p>${escapeHtml(quote)}</p><span>${escapeHtml(name)}</span></article>`;
}

function professionalPhonePreview(photo, label) {
  return `
    <div class="pro-phone">
      <div class="pro-phone-top"><span>${escapeHtml(label)}</span><b>9:16</b></div>
      <div class="pro-phone-stage reel-depth-zoom">
        <img src="${photo.uri}" alt="">
        <div class="pro-video-vignette"></div>
        <div class="pro-address-card">${escapeHtml(state.project.address || "1234 E Camelback Road")}</div>
        <div class="pro-stat-card">${escapeHtml(state.project.price || "$1,250,000")} · ${escapeHtml(state.project.beds || "4")} BD · ${escapeHtml(state.project.baths || "3")} BA</div>
        <div class="pro-lower-third"><strong>${escapeHtml(aiCopy().hook)}</strong><span>${escapeHtml(state.brandKit.name || "EstateMotion Agent")}</span></div>
      </div>
    </div>
  `;
}

function renderUpload() {
  const photos = orderedPhotos();
  const isAnonymousLive = !featureFlags.MOCK_SUPABASE && !authUser && !isDemoRoute();
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Photos</p><h2>Drop in your listing photos.</h2><p>Start with the real property images you already have. You can preview before creating an account.</p></div>
    ${isAnonymousLive ? `<section class="panel sign-in-required-card"><div><p class="eyebrow">No account needed yet</p><h3>Build the preview first.</h3><p class="muted">Create your free account only when you are ready to save and export the finished video.</p></div><button class="secondary" data-auth-entry-upload>Sign in</button></section>` : ""}
    <section class="upload-studio-card pro-upload-card">
      <label class="upload-zone" data-upload-zone>
        <input id="photoInput" type="file" accept="image/*" multiple>
        <span class="upload-plus">+</span>
        <strong>Upload 8-25 listing photos</strong>
        <span class="muted">JPG, PNG, or WebP. Select multiple photos at once or drag a full listing set here.</span>
        <b class="upload-count">${photos.length} photo${photos.length === 1 ? "" : "s"} uploaded</b>
      </label>
      <aside class="upload-status-card">
        <span>Video readiness</span>
        <strong>${photos.length >= 3 ? "Photos ready for AI ordering" : "Add at least 3 photos"}</strong>
        <small>${isAnonymousLive ? "Your preview is local until export." : "Ready for final video export."}</small>
      </aside>
    </section>
    <section class="panel listing-basics-panel">
      <div class="section-title"><p>Listing details</p><h3>Add the facts that should appear on the video.</h3></div>
      <div class="grid-2">${field("Property address", "address")}${field("Price", "price")}</div>
      <div class="grid-2">${field("Beds", "beds")}${field("Baths", "baths")}</div>
      <div class="grid-2">${field("Square footage", "squareFeet")}${field("City / area", "city")}</div>
      <div class="grid-2">${brandField("Agent name", "name")}${brandField("Brokerage", "brokerage")}</div>
    </section>
    <div class="actions single-primary-row">
      <button class="secondary" data-add-more type="button">Add more photos</button>
      <button class="secondary" data-sample-listing type="button">Use sample listing</button>
      <button class="primary" data-next="processing">Build My Video</button>
    </div>
    <section class="photo-grid pro-photo-grid">
      ${photos.length ? photos.map((photo, index) => photoCard(photo, index)).join("") : emptyState("No photos uploaded", "Upload listing photos or use the sample listing to see a professional output.")}
    </section>
  `);
  const input = document.querySelector("#photoInput");
  input.addEventListener("change", handlePhotoFiles);
  document.querySelector("[data-add-more]").addEventListener("click", () => input.click());
  document.querySelector("[data-auth-entry-upload]")?.addEventListener("click", () => setState({ authMode: "sign-in", authReturnScreen: "upload", screen: "auth", error: "" }));
  document.querySelector("[data-sample-listing]").addEventListener("click", loadBetaSampleListing);
  document.querySelector("[data-next]").addEventListener("click", () => guard(validatePhotos(), () => navigate("processing")));
  bindUploadDropZone();
  bindPhotoControls();
}

function renderProcessing() {
  ensureMotionDirectorPlan();
  const plan = activeEditableReelPlan();
  const sequence = sequenceFromEditedPlan(plan);
  const captions = pipelineCaptions(sequence);
  const captionByScene = new Map(captions.map((item) => [item.sceneId, item.caption]));
  const totalDuration = beatSyncPlan(renderManifestScenes(sequence)).totalDuration;
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Step 2 of 4</p><h2>Your tour, sequenced.</h2><p>Reorder, remove, or rewrite captions. Continue when it feels right.</p></div>
    <section class="panel reel-plan-panel">
      <header class="reel-plan-header">
        <div>
          <p class="reel-plan-eyebrow">Photo order</p>
          <h3>${sequence.scenes.length} ${sequence.scenes.length === 1 ? "scene" : "scenes"} &middot; ${totalDuration}s runtime</h3>
        </div>
        <button class="ghost reel-plan-refresh" data-regenerate-edit-plan title="Generate a fresh order">Regenerate</button>
      </header>
      <div class="reel-plan-grid">
        ${sequence.scenes.map((scene, index) => reelPlanRow(scene, index, captionByScene.get(scene.id))).join("")}
      </div>
      <div class="actions single-primary-row">
        <button class="ghost" data-reset-ai-plan>Reset order</button>
        <button class="primary" data-next-style>Continue to style &rarr;</button>
      </div>
    </section>
  `);
  bindReelPlanEditor(plan);
  document.querySelector("[data-regenerate-edit-plan]")?.addEventListener("click", () => regenerateMotionDirectorPlan());
  document.querySelector("[data-next-style]")?.addEventListener("click", () => guard(validateReelPlanBeforePreview(), () => navigate("template")));
}

function renderTemplate() {
  const styleTemplates = listingVideoTemplates();
  const selectedStyle = styleTemplates.find((item) => item.id === normalizeTemplateId(state.selectedTemplateId)) || styleTemplates[0];
  const selectedEngineTemplate = templates.find((entry) => entry.id === selectedStyle.id) || selectedTemplate();
  renderLayout(`
    <div class="screen-title cinematic-title style-gallery-title"><p class="eyebrow">Template Gallery</p><h2>Choose Your Video Style</h2><p>Select the look and feel that matches your listing and audience.</p></div>
    <section class="style-gallery-layout">
      <div class="style-gallery-grid">
        ${styleTemplates.map((item, index) => {
        const template = templates.find((entry) => entry.id === item.id) || templates[0];
        const selected = template.id === normalizeTemplateId(state.selectedTemplateId);
        return `<button class="style-template-card ${selected ? "selected" : ""}" data-template="${template.id}" style="--template-accent:${template.accentColor}; --style-image:url('${item.previewImage}')">
          <span class="style-card-media">
            <img src="${escapeAttr(item.previewImage)}" alt="">
            <span class="style-video-shimmer"></span>
            <span class="style-card-overlay">
              ${index === 0 ? `<b class="recommended-badge">Recommended</b>` : `<b>${escapeHtml(item.badge)}</b>`}
              <em>${escapeHtml(item.motion)}</em>
            </span>
          </span>
          <span class="style-card-copy">
            <span class="style-card-kicker">${escapeHtml(item.bestFor)}</span>
            <strong>${escapeHtml(item.label)}</strong>
            <small>${escapeHtml(item.description)}</small>
          </span>
          <span class="style-card-actions">
            <span>${selected ? "Selected" : "Select style"}</span>
            <small>Preview sample</small>
          </span>
        </button>`;
      }).join("")}
      </div>
      <aside class="style-preview-panel">
        <div class="section-title"><p>Selected Style</p><h3>${escapeHtml(selectedStyle.label)}</h3></div>
        <div class="style-preview-device">
          ${styleGalleryPhonePreview(selectedStyle, selectedEngineTemplate)}
        </div>
        <div class="style-preview-details">
          <span>${escapeHtml(selectedStyle.bestFor)}</span>
          <strong>${escapeHtml(selectedStyle.previewTone)}</strong>
          <p>${escapeHtml(selectedStyle.description)}</p>
        </div>
      </aside>
    </section>
    <div class="actions single-primary-row">
      <button class="secondary" data-back-order>Back to order</button>
      <button class="primary" data-next="preview">Continue to Preview</button>
    </div>
  `);
  document.querySelectorAll("[data-template]").forEach((button) => button.addEventListener("click", () => {
    trackEvent("template_select", { templateId: button.dataset.template });
    setState((current) => ({ ...current, selectedTemplateId: button.dataset.template, project: { ...current.project, reelPlanEdits: null, motionDirectorPlan: null, motionDirectorStatus: motionDirectorIdleStatus(current.project.motionDirectorStatus) } }));
  }));
  document.querySelector("[data-back-order]").addEventListener("click", () => navigate("processing"));
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics() || validatePhotos() || validateTemplate(), () => navigate("preview")));
}

function styleGalleryPhonePreview(style, template) {
  const photo = orderedPhotos()[0] || { uri: style.previewImage, category: "Exterior hero" };
  const image = photo.uri || style.previewImage;
  return `
    <div class="style-phone-preview" style="--template-accent:${template.accentColor || "#C7A76C"}">
      <img src="${escapeAttr(image)}" alt="">
      <div class="style-phone-gradient"></div>
      <div class="style-phone-topline">${escapeHtml(style.label)}</div>
      <div class="style-phone-title">${escapeHtml(state.project.address || "Featured Listing")}</div>
      <div class="style-phone-stats">${escapeHtml(state.project.price || "$1,250,000")} · ${escapeHtml(state.project.beds || "4")} BD · ${escapeHtml(state.project.baths || "3")} BA</div>
      <div class="style-phone-caption">${escapeHtml(style.motion)}</div>
    </div>
  `;
}

function renderPreview() {
  const sequence = createPipelineSequence();
  const manifestScenes = renderManifestScenes(sequence);
  const photos = sequence.scenes.length ? sequence.scenes.map((scene) => scene.photo) : orderedPhotos();
  const photo = photos[state.selectedScene] ?? photos[0] ?? demoPhotos[0];
  const copy = aiCopy();
  const template = selectedTemplate();
  const pacing = manifestScenes.map((scene) => ({
    motionStyle: scene.motionStyle,
    duration: scene.duration,
    beatMarker: scene.beatMarker,
    move: motionToClass(scene.renderMotion || scene.motionStyle)
  }));
  const currentPlan = pacing[state.selectedScene] ?? reelPacing(photos)[state.selectedScene] ?? motionPlanForPhoto(photo, state.selectedScene);
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Real Preview</p><h2>This is your actual video style.</h2><p>EstateMotion previews the same scene order, motion direction, transitions, overlays, and beat timing sent to the renderer.</p></div>
    <section class="preview-suite pro-preview-suite">
      <div class="video-player-shell">
        <div class="player-chrome"><span>Mini rendered preview</span><b>${escapeHtml(selectedListingVideoStyleLabel())}</b></div>
        ${motionSequencePreview(manifestScenes, template)}
      </div>
      <aside class="preview-inspector panel export-status-card">
        <div class="section-title"><p>Video feel</p><h3>${escapeHtml(currentPlan.motionStyle)}</h3></div>
        <p class="muted">Scene-aware camera movement, timed transitions, animated text, and safe-area overlays are active in this preview.</p>
        <div class="metric-row"><span>Scene</span><b>${escapeHtml(sceneLabel(photo.category))}</b></div>
        <div class="metric-row"><span>Duration</span><b>${escapeHtml(currentPlan.duration)}s</b></div>
        <div class="metric-row"><span>Beat marker</span><b>${escapeHtml(currentPlan.beatMarker)}</b></div>
        <div class="metric-row"><span>Music pacing</span><b>${escapeHtml(selectedMusicTrack().mood)}</b></div>
        <div class="metric-row"><span>Exports</span><b>9:16 / 16:9 / 1:1</b></div>
        <div class="metric-row"><span>Variants</span><b>Branded / unbranded</b></div>
      </aside>
    </section>
    <div class="actions single-primary-row">
      <button class="secondary" data-scene="-1">Previous scene</button>
      <button class="secondary" data-scene="1">Next scene</button>
      <button class="primary" data-next="export">Export My Video</button>
    </div>
    <section class="panel scene-card-panel">
      <div class="section-title"><p>Timeline</p><h3>${photos.length} scenes / ${beatSyncPlan(renderManifestScenes()).totalDuration}s</h3></div>
      <div class="scene-card-grid">${photos.map((item, index) => sceneCard(item, index, pacing[index])).join("")}</div>
    </section>
  `);
  document.querySelectorAll("[data-scene]").forEach((button) => button.addEventListener("click", () => {
    const next = Math.max(0, Math.min(photos.length - 1, state.selectedScene + Number(button.dataset.scene)));
    setState({ selectedScene: next });
  }));
  document.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => setState({ selectedScene: Number(button.dataset.jump) })));
  document.querySelector("[data-next]").addEventListener("click", () => guard(validateProjectBasics() || validatePhotos() || validateTemplate(), () => navigate("export")));
}

function motionSequencePreview(scenes = renderManifestScenes(), template = selectedTemplate()) {
  const safeScenes = scenes.length ? scenes : renderManifestScenes(createPipelineSequence());
  const total = Math.max(1, beatSyncPlan(safeScenes).totalDuration);
  const previewId = `motion-preview-${slug(templatePipelineId())}-${safeScenes.length}-${Math.round(total * 10)}`;
  const sceneKeyframes = safeScenes.map((scene, index) => {
    const duration = Math.max(1, Number(scene.duration || 2));
    const start = Math.max(0, Number(scene.beatStart || 0));
    const startPct = Math.max(0, Math.min(99, (start / total) * 100));
    const endPct = Math.max(startPct + 2, Math.min(99.6, ((start + duration) / total) * 100));
    const fadePct = Math.min(3, Math.max(1, (duration / total) * 10));
    const before = Math.max(0, startPct - fadePct);
    const visibleIn = Math.min(99, startPct + Math.min(1.6, fadePct));
    const visibleOut = Math.max(visibleIn + 0.2, endPct - Math.min(1.6, fadePct));
    const after = Math.min(100, endPct + fadePct);
    const name = `${previewId}-scene-${index}`;
    if (startPct <= 0.2) {
      return `@keyframes ${name}{0%,${visibleOut.toFixed(2)}%{opacity:1;filter:blur(0)}${after.toFixed(2)}%,100%{opacity:0;filter:blur(7px)}}`;
    }
    return `@keyframes ${name}{0%,${before.toFixed(2)}%{opacity:0;filter:blur(7px)}${visibleIn.toFixed(2)}%,${visibleOut.toFixed(2)}%{opacity:1;filter:blur(0)}${after.toFixed(2)}%,100%{opacity:0;filter:blur(7px)}}`;
  }).join("");
  return `
    <section class="motion-preview-reel style-${templatePipelineId()}" style="--preview-duration:${total}s; --reel-accent:${template.accentColor || "#C7A76C"}">
      <style>${sceneKeyframes}</style>
      ${safeScenes.map((scene, index) => {
        const duration = Math.max(1, Number(scene.duration || 2));
        const start = Math.max(0, Number(scene.beatStart || 0));
        const motionClass = motionToClass(scene.renderMotion || scene.motionStyle);
        const transitionClass = transitionToClass(scene.transition || scene.directorTransition);
        const visibleFor = Math.min(total, duration + 0.55);
        return `<article class="motion-preview-scene reel-${slug(motionClass)} transition-${transitionClass}" style="--scene-start:${start}s; --scene-duration:${visibleFor}s; --scene-index:${index}; animation-name:${previewId}-scene-${index}; animation-duration:${total}s;">
          <img src="${escapeAttr(scene.imageUrl || scene.publicUrl || scene.durableUrl || "")}" alt="">
          <div class="motion-preview-gradient"></div>
          <div class="motion-preview-address">${escapeHtml(index === 0 ? (state.project.address || "Featured Listing") : scene.sceneType)}</div>
          <div class="motion-preview-copy"><span>${escapeHtml(scene.motionStyle || "Cinematic motion")}</span><strong>${escapeHtml(scene.overlayText || aiCopy().hook)}</strong>${scene.overlaySubline ? `<small>${escapeHtml(scene.overlaySubline)}</small>` : ""}</div>
          <div class="motion-preview-transition"></div>
        </article>`;
      }).join("")}
      <div class="motion-preview-safe"></div>
      <div class="motion-preview-stats">${escapeHtml(state.project.price || "Price available")} · ${escapeHtml(state.project.beds || "-")} BD · ${escapeHtml(state.project.baths || "-")} BA · ${escapeHtml(state.project.squareFeet || "-")} SQ FT</div>
      ${state.project.brandingVisible ? `<div class="motion-preview-brand"><strong>${escapeHtml(state.brandKit.name || "EstateMotion Agent")}</strong><span>${escapeHtml(state.brandKit.brokerage || "Real Estate Advisor")}</span></div>` : ""}
      <div class="motion-preview-progress">${safeScenes.map((_, index) => `<span style="--dot-index:${index}"></span>`).join("")}</div>
    </section>
  `;
}

function transitionToClass(transition = "") {
  const value = String(transition || "").toLowerCase();
  if (value.includes("whip")) return "whip";
  if (value.includes("light")) return "light";
  if (value.includes("blur")) return "blur";
  if (value.includes("match")) return "match";
  if (value.includes("zoom")) return "zoom";
  if (value.includes("slide")) return "slide";
  return "fade";
}

function reelStage(photo, copy, template, index = 0, total = 1) {
  const manifestScene = renderManifestScenes()[index];
  const pacing = manifestScene ? {
    move: motionToClass(manifestScene.renderMotion || manifestScene.motionStyle),
    motionStyle: manifestScene.motionStyle,
    beatMarker: manifestScene.beatMarker,
    duration: manifestScene.duration,
    overlayText: manifestScene.overlayText,
    overlaySubline: manifestScene.overlaySubline
  } : (reelPacing(orderedPhotos())[index] ?? motionPlanForPhoto(photo, index));
  const category = sceneLabel(photo?.category || "Detail shots");
  return `
    <section class="reel-stage pro-reel-stage reel-${slug(pacing.move)}" style="--reel-accent:${template.accentColor || "#C7A76C"}">
      <img src="${photo.uri}" alt="">
      <div class="cinematic-gradient"></div>
      <div class="safe-frame"></div>
      <div class="address-intro-card">${escapeHtml(state.project.address || "Listing Video")}</div>
      <div class="property-stat-card">${escapeHtml(state.project.price || "Price available")} · ${escapeHtml(state.project.beds || "-")} BD · ${escapeHtml(state.project.baths || "-")} BA · ${escapeHtml(state.project.squareFeet || "-")} SQ FT</div>
      <div class="scene-lower-third"><span>${escapeHtml(category)}</span><strong>${escapeHtml(pacing.overlayText || copy.hook)}</strong>${pacing.overlaySubline ? `<small>${escapeHtml(pacing.overlaySubline)}</small>` : ""}</div>
      <div class="motion-badge">${escapeHtml(pacing.motionStyle || "Depth zoom")} · ${escapeHtml(pacing.beatMarker || "Beat cut")}</div>
      ${state.project.brandingVisible ? `<div class="pro-outro-card"><strong>${escapeHtml(state.brandKit.name || "EstateMotion Agent")}</strong><span>${escapeHtml(state.brandKit.brokerage || "Brokerage")}</span></div>` : ""}
      <div class="reel-progress">${Array.from({ length: total }, (_, dotIndex) => `<span class="${dotIndex <= index ? "active" : ""}"></span>`).join("")}</div>
    </section>
  `;
}

function renderExport() {
  const result = buildExportPayload();
  const accountGate = exportRequiresAccount();
  const preflightError = accountGate ? "" : validatePreRenderManifest(result, { live: !featureFlags.MOCK_RENDERING });
  const mp4Url = state.exportResult?.mp4Url || state.renderJobStatus?.mp4Url || "";
  const isRendering = ["queued", "rendering"].includes(state.renderJobStatus?.status);
  const exportOptions = [
    ["Vertical Reel", "9:16 branded MP4", "Instagram / TikTok / Shorts"],
    ["Horizontal Tour", "16:9 branded MP4", "YouTube / website"],
    ["Square Feed", "1:1 branded MP4", "Instagram feed"],
    ["MLS Clean", "Unbranded clean MP4", "Compliance-ready"],
    ["Caption Pack", "Caption + hashtags", "Post-ready copy"]
  ];
  renderLayout(`
    <div class="screen-title cinematic-title"><p class="eyebrow">Export</p><h2>Your listing video is ready.</h2><p>Create polished versions for Reels, TikTok, YouTube, your website, and MLS-safe sharing.</p></div>
    <section class="export-delivery-grid">
      <div class="video-player-shell export-preview-shell">
        <div class="player-chrome"><span>Final video preview</span><b>${escapeHtml(selectedListingVideoStyleLabel())}</b></div>
        ${motionSequencePreview(result.scenes, selectedTemplate())}
      </div>
      <section class="panel elevated export-command">
        <div class="section-title"><p>Delivery</p><h3>${accountGate ? "Create account to export" : preflightError ? "One more step" : "Ready to create files"}</h3></div>
        ${accountGate ? `<div class="state-banner loading-state"><strong>Your preview is ready</strong><span>Create your free account to save the project and export the finished video.</span></div>` : preflightError ? `<div class="state-banner error-state"><strong>Export needs attention</strong><span>${escapeHtml(publicFacingError(preflightError))}</span></div>` : mp4Url ? `<div class="state-banner loading-state"><strong>Real MP4 complete</strong><span>Your final listing video is ready to watch and download below.</span></div>` : isRendering ? `<div class="state-banner loading-state"><span class="spinner"></span><strong>${escapeHtml(state.renderJobStatus.phase || "Rendering scenes")}</strong></div>` : `<div class="state-banner loading-state"><strong>Ready for real MP4 rendering</strong><span>EstateMotion will send this validated manifest to Remotion and create a 45-60 second listing video.</span></div>`}
        <div class="render-quality-strip">
          <span>Camera motion: ${escapeHtml([...new Set(result.scenes.map((scene) => scene.cameraMotion || scene.renderMotion).filter(Boolean))].slice(0, 3).join(" / "))}</span>
          <span>Transitions: ${escapeHtml([...new Set(result.scenes.map((scene) => scene.transition).filter(Boolean))].slice(0, 3).join(" / "))}</span>
          <span>Music: ${escapeHtml(result.musicTiming?.track?.label || selectedMusicTrack().label)}</span>
        </div>
        <div class="export-option-grid">${exportOptions.map(([title, body, format]) => exportOptionCard(title, body, format)).join("")}</div>
        <div class="actions single-primary-row">
          <button class="primary" data-queue-pack ${isRendering ? "disabled" : ""}>${mp4Url ? "Render Again" : "Generate Video"}</button>
          ${mp4Url ? `<a class="secondary button-link" href="${escapeAttr(mp4Url)}" download target="_blank" rel="noreferrer">Download MP4</a>` : ""}
        </div>
      </section>
    </section>
    ${renderQueuePanel()}
  `);
  document.querySelector("[data-queue-pack]").addEventListener("click", queueContentPack);
  document.querySelector("[data-retry-render]")?.addEventListener("click", queueContentPack);
}

function contentPack() {
  const photos = orderedPhotos();
  return [
    { id: "vertical-branded", title: "Vertical Reel - Branded", format: "9:16", duration: 28, hook: aiCopy().hook, photoIds: photos.map((photo) => photo.id) },
    { id: "vertical-unbranded", title: "Vertical Reel - Unbranded", format: "9:16", duration: 28, hook: aiCopy().hook, photoIds: photos.map((photo) => photo.id) },
    { id: "wide-branded", title: "Horizontal Tour - Branded", format: "16:9", duration: 28, hook: aiCopy().hook, photoIds: photos.map((photo) => photo.id) },
    { id: "square-branded", title: "Square Feed Video", format: "1:1", duration: 22, hook: aiCopy().hook, photoIds: photos.slice(0, 10).map((photo) => photo.id) },
    { id: "mls-clean", title: "MLS Clean - Unbranded", format: "16:9", duration: 24, hook: "Property tour", photoIds: photos.map((photo) => photo.id) }
  ];
}

function ensureMotionDirectorPlan() {
  if (state.loading || state.screen !== "processing") return;
  const signature = motionDirectorSignature();
  if (motionDirectorInFlightSignature === signature) return;
  if (state.project.motionDirectorStatus?.signature === signature && ["complete", "fallback", "unavailable", "limit"].includes(state.project.motionDirectorStatus.status)) return;
  if (state.project.motionDirectorPlan?.signature === signature && state.project.reelPlanEdits?.source === "motion-director") return;
  motionDirectorInFlightSignature = signature;
  window.setTimeout(() => createMotionDirectorPlan({ signature, force: false }), 0);
}

async function regenerateMotionDirectorPlan() {
  const signature = motionDirectorSignature();
  await createMotionDirectorPlan({ signature, force: true });
}

async function createMotionDirectorPlan({ signature = motionDirectorSignature(), force = false } = {}) {
  if (state.loading) return;
  const photos = orderedPhotos();
  if (photos.length < 3) return;
  const apiPhotos = motionDirectorPhotoInputs();
  const urlIssue = motionDirectorUrlIssue(apiPhotos);
  const usage = motionDirectorUsage();
  const canAttemptOpenAI = !featureFlags.MOCK_AI && !urlIssue && usage.openaiCalls < usage.callLimit;
  const unavailableReason = featureFlags.MOCK_AI
    ? "MOCK_AI=true, so EstateMotion is using the local deterministic planner."
    : urlIssue || (usage.openaiCalls >= usage.callLimit ? `Motion Director call limit reached for this session (${usage.openaiCalls}/${usage.callLimit}).` : "");
  if (!force && !canAttemptOpenAI && state.project.motionDirectorStatus?.signature === signature) return;
  motionDirectorInFlightSignature = signature;
  setState((current) => ({
    ...current,
    loading: "Sequencing your tour…",
    error: "",
    project: {
      ...current.project,
      motionDirectorStatus: {
        ...motionDirectorUsage(current.project.motionDirectorStatus),
        status: "planning",
        label: canAttemptOpenAI ? "OpenAI-directed edit plan" : "Fallback edit plan",
        reason: canAttemptOpenAI ? "Analyzing uploaded photos and creating a fresh edit plan." : unavailableReason,
        signature,
        source: canAttemptOpenAI ? "openai-motion-director" : "deterministic-fallback",
        lastRunAt: new Date().toISOString()
      }
    }
  }));
  try {
    const fallbackPlan = deterministicMotionDirectorPlan();
    let payload = { status: "fallback", editPlan: fallbackPlan, reason: unavailableReason || "OpenAI Motion Director unavailable." };
    let openaiCalls = usage.openaiCalls;
    if (canAttemptOpenAI) {
      openaiCalls += 1;
      const response = await fetchWithTimeout(featureFlags.CREATE_EDIT_PLAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photos: apiPhotos,
          listingDetails: pipelineListingDetails(),
          selectedStyle: selectedListingVideoStyleLabel(),
          exportFormat: "vertical"
        })
      }, 30000);
      payload = await response.json().catch(() => payload);
      if (!response.ok) throw new Error(motionDirectorPayloadReason(payload) || "OpenAI Motion Director request failed.");
    }
    const validation = validateMotionDirectorPlan(payload.editPlan, photos);
    const editPlan = validation.valid ? payload.editPlan : fallbackPlan;
    const normalized = normalizeMotionDirectorPlan(editPlan, payload.status === "complete" ? "openai-motion-director" : "deterministic-fallback", signature);
    const reelPlanEdits = reelPlanFromMotionDirector(normalized);
    const status = motionDirectorStatusForResult(normalized, payload.reason || unavailableReason || validation.error, signature, openaiCalls);
    setState((current) => ({
      ...current,
      loading: "",
      project: {
        ...current.project,
        motionDirectorPlan: normalized,
        reelPlanEdits,
        motionDirectorStatus: status
      }
    }));
    showToast("Edit plan ready");
  } catch (error) {
    const normalized = normalizeMotionDirectorPlan(deterministicMotionDirectorPlan(), "deterministic-fallback", signature);
    const reason = error.name === "AbortError" ? "Edit plan ready (used fast mode)." : (error.message || "Edit plan ready (used fast mode).");
    setState((current) => ({
      ...current,
      loading: "",
      project: {
        ...current.project,
        motionDirectorPlan: normalized,
        reelPlanEdits: reelPlanFromMotionDirector(normalized),
        motionDirectorStatus: motionDirectorStatusForResult(normalized, reason, signature, usage.openaiCalls + (canAttemptOpenAI ? 1 : 0))
      }
    }));
    showToast(`Motion Director fallback used. ${reason}`, "error");
  } finally {
    if (motionDirectorInFlightSignature === signature) motionDirectorInFlightSignature = "";
  }
}

function motionDirectorPayloadReason(payload = {}) {
  const categoryLabels = {
    invalid_model: "invalid OpenAI model",
    inaccessible_image_url: "inaccessible image URL",
    schema_validation: "edit-plan schema validation failed",
    rate_limit: "OpenAI rate limit",
    billing_or_quota: "OpenAI billing or quota",
    timeout: "OpenAI timeout",
    missing_openai_api_key: "missing OPENAI_API_KEY",
    invalid_photo_urls: "invalid photo URLs",
    too_few_photos: "too few photos"
  };
  const label = categoryLabels[payload.errorCategory] || "";
  const message = payload.reason || payload.error || "";
  return label && message && !message.toLowerCase().includes(label.toLowerCase())
    ? `${label}: ${message}`
    : message;
}

function motionDirectorUsage(status = state.project.motionDirectorStatus || {}) {
  return {
    openaiCalls: Number(status.openaiCalls || 0),
    callLimit: Number(status.callLimit || 3)
  };
}

function motionDirectorIdleStatus(previous = {}) {
  const usage = motionDirectorUsage(previous);
  return {
    status: "idle",
    label: "Motion Director pending",
    reason: "",
    signature: "",
    source: "",
    lastRunAt: "",
    ...usage
  };
}

function motionDirectorStatusForResult(plan, reason, signature, openaiCalls) {
  const source = plan.source === "openai-motion-director" ? "openai-motion-director" : "deterministic-fallback";
  const usage = motionDirectorUsage();
  return {
    status: source === "openai-motion-director" ? "complete" : "fallback",
    label: source === "openai-motion-director" ? "OpenAI-directed edit plan" : "Fallback edit plan",
    reason: source === "openai-motion-director" ? "OpenAI Vision directed the scene order, motion, transitions, and overlays from the uploaded photos." : (reason || "OpenAI Motion Director was unavailable, so the deterministic fallback planner created the edit."),
    signature,
    source,
    lastRunAt: new Date().toISOString(),
    openaiCalls,
    callLimit: usage.callLimit
  };
}

function motionDirectorDisplayStatus() {
  const status = state.project.motionDirectorStatus || motionDirectorIdleStatus();
  const usage = motionDirectorUsage(status);
  if (status.status === "planning") {
    return {
      className: "planning",
      label: "Motion Director",
      headline: status.label || "Planning edit",
      reason: status.reason || "Creating a scene order, camera motion plan, transitions, and overlays.",
      summary: "Motion Director is creating an edit plan from the uploaded listing photos.",
      metric: "Planning",
      disabled: true
    };
  }
  if (status.source === "openai-motion-director" || status.status === "complete") {
    return {
      className: "openai",
      label: "Motion Director",
      headline: "OpenAI-directed edit plan",
      reason: `${status.reason || "OpenAI Vision directed this plan."} Usage ${usage.openaiCalls}/${usage.callLimit}.`,
      summary: "OpenAI Motion Director created this edit plan from the visible listing photos.",
      metric: "OpenAI",
      disabled: false
    };
  }
  if (status.status === "fallback" || status.source === "deterministic-fallback") {
    return {
      className: "fallback",
      label: "Motion Director unavailable",
      headline: "Fallback edit plan",
      reason: `${status.reason || "Fallback planner created this edit."} Usage ${usage.openaiCalls}/${usage.callLimit}.`,
      summary: "EstateMotion is using the deterministic fallback planner until OpenAI Motion Director is available.",
      metric: "Fallback",
      disabled: false
    };
  }
  return {
    className: "idle",
    label: "Motion Director",
    headline: "Edit plan pending",
    reason: "EstateMotion will create an edit plan once this screen finishes loading.",
    summary: "EstateMotion is preparing the property-tour order from the uploaded listing photos.",
    metric: "Pending",
    disabled: true
  };
}

function motionDirectorUrlIssue(photos) {
  if (!photos.length) return "No uploaded photos are available for Motion Director.";
  const invalid = photos.filter((photo) => !photo.durableUrl || isLocalOnlyUrl(photo.durableUrl));
  if (!invalid.length) return "";
  return `${invalid.length} photo URL${invalid.length === 1 ? " is" : "s are"} local or temporary. Sign in and upload to Supabase Storage before using OpenAI Motion Director.`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function motionDirectorSignature() {
  return [
    normalizeTemplateId(state.selectedTemplateId),
    "vertical",
    orderedPhotos().map((photo) => `${photo.id}:${photo.durableUrl || photo.publicUrl || photo.uri}`).join("|"),
    state.project.address,
    state.project.price,
    state.project.beds,
    state.project.baths,
    state.project.squareFeet
  ].join("::");
}

function motionDirectorPhotoInputs() {
  return orderedPhotos().map((photo, index) => ({
    id: photo.id,
    photoId: photo.id,
    durableUrl: photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || photo.uri || "",
    publicUrl: photo.publicUrl || photo.public_url || "",
    imageUrl: photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || photo.uri || "",
    fileName: photo.fileName || `photo-${index + 1}.jpg`,
    category: sceneLabel(photo.category),
    width: photo.width || 0,
    height: photo.height || 0
  }));
}

function deterministicMotionDirectorPlan() {
  const photos = motionDirectorPhotoInputs();
  const sorted = photos
    .map((photo, index) => ({ ...photo, roomType: mdRoomType(photo, index), qualityScore: mdQualityScore(photo, index) }))
    .sort((a, b) => mdRoomRank(a.roomType) - mdRoomRank(b.roomType) || b.qualityScore - a.qualityScore);
  const scenes = sorted.slice(0, 10).map((photo, index) => ({
    photoId: photo.id,
    order: index + 1,
    roomType: photo.roomType,
    visibleFeatures: mdVisibleFeatures(photo, photo.roomType),
    qualityScore: photo.qualityScore,
    duration: mdDuration(photo.roomType, index),
    cameraMotion: mdCameraMotion(photo.roomType, index),
    transition: mdTransition(photo.roomType, index),
    overlay: mdOverlay(photo.roomType, index)
  }));
  return {
    heroPhotoId: scenes[0]?.photoId || photos[0]?.id,
    exportFormat: "vertical",
    selectedStyle: selectedListingVideoStyleLabel(),
    musicMood: selectedMusicTrack().mood || "slow cinematic",
    introCard: {
      headline: state.project.address || "Featured listing",
      subline: [state.project.price, state.project.city].filter(Boolean).join(" · ")
    },
    outroCard: {
      headline: state.brandKit.name || "Schedule a private tour",
      subline: state.brandKit.brokerage || state.project.cta || "Contact the listing agent"
    },
    scenes
  };
}

function normalizeMotionDirectorPlan(plan, source, signature) {
  const photos = new Map(orderedPhotos().map((photo) => [photo.id, photo]));
  const fallback = deterministicMotionDirectorPlan();
  const base = plan?.scenes?.length ? plan : fallback;
  const scenes = [...base.scenes]
    .filter((scene) => photos.has(scene.photoId))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .slice(0, 12)
    .map((scene, index) => ({
      photoId: scene.photoId,
      order: index + 1,
      roomType: mdAllowedRoomTypes().includes(scene.roomType) ? scene.roomType : mdRoomType(photos.get(scene.photoId), index),
      visibleFeatures: Array.isArray(scene.visibleFeatures) ? scene.visibleFeatures.map((item) => String(item).trim()).filter(Boolean).slice(0, 5) : [],
      qualityScore: Math.max(0, Math.min(100, Math.round(Number(scene.qualityScore || 70)))),
      duration: Math.max(1.2, Math.min(5, Number(scene.duration || 2.4))),
      cameraMotion: mdAllowedCameraMotions().includes(scene.cameraMotion) ? scene.cameraMotion : mdCameraMotion(scene.roomType, index),
      transition: mdAllowedTransitions().includes(scene.transition) ? scene.transition : mdTransition(scene.roomType, index),
      overlay: {
        headline: String(scene.overlay?.headline || mdOverlay(scene.roomType, index).headline || "").slice(0, 70),
        subline: String(scene.overlay?.subline || mdOverlay(scene.roomType, index).subline || "").slice(0, 90)
      }
    }));
  return {
    id: `motion-director-${Date.now()}`,
    source,
    signature,
    heroPhotoId: photos.has(base.heroPhotoId) ? base.heroPhotoId : scenes[0]?.photoId,
    exportFormat: "vertical",
    selectedStyle: selectedListingVideoStyleLabel(),
    musicMood: String(base.musicMood || selectedMusicTrack().mood || "slow cinematic").slice(0, 80),
    introCard: {
      headline: String(base.introCard?.headline || state.project.address || "Featured listing").slice(0, 80),
      subline: String(base.introCard?.subline || [state.project.price, state.project.city].filter(Boolean).join(" · ")).slice(0, 100)
    },
    outroCard: {
      headline: String(base.outroCard?.headline || state.brandKit.name || "Schedule a private tour").slice(0, 80),
      subline: String(base.outroCard?.subline || state.brandKit.brokerage || "").slice(0, 100)
    },
    scenes
  };
}

function validateMotionDirectorPlan(plan, photos = orderedPhotos()) {
  const ids = new Set(photos.map((photo) => photo.id));
  if (!plan || !Array.isArray(plan.scenes) || plan.scenes.length < 3) return { valid: false, error: "Edit plan needs at least 3 scenes." };
  if (!ids.has(plan.heroPhotoId)) return { valid: false, error: "Hero photo must be one of the uploaded photos." };
  const seen = new Set();
  for (const scene of plan.scenes) {
    if (!ids.has(scene.photoId)) return { valid: false, error: "Scene references a photo that was not uploaded." };
    if (seen.has(scene.photoId)) return { valid: false, error: "Scene repeats a photo." };
    seen.add(scene.photoId);
    if (!mdAllowedRoomTypes().includes(scene.roomType)) return { valid: false, error: "Unsupported room type." };
    if (!mdAllowedCameraMotions().includes(scene.cameraMotion)) return { valid: false, error: "Unsupported camera motion." };
    if (!mdAllowedTransitions().includes(scene.transition)) return { valid: false, error: "Unsupported transition." };
  }
  return { valid: true, error: "" };
}

function reelPlanFromMotionDirector(plan) {
  return {
    id: plan.id,
    source: "motion-director",
    directorSource: plan.source,
    introText: plan.introCard.headline,
    outroText: plan.outroCard.headline,
    claimConfirmed: false,
    scenes: plan.scenes.map((scene) => ({
      id: `director-${scene.order}`,
      photoId: scene.photoId,
      category: mdRoomToPipelineCategory(scene.roomType),
      caption: [scene.overlay.headline, scene.overlay.subline].filter(Boolean).join(" · "),
      duration: scene.duration,
      order: scene.order,
      cameraMotion: scene.cameraMotion,
      transition: scene.transition,
      visibleFeatures: scene.visibleFeatures,
      qualityScore: scene.qualityScore
    }))
  };
}

function createPipelineSequence() {
  if (state.project.reelPlanEdits?.scenes?.length) return sequenceFromEditedPlan(state.project.reelPlanEdits);
  if (state.project.motionDirectorPlan?.scenes?.length) return sequenceFromMotionDirectorPlan(state.project.motionDirectorPlan);
  return createAISequence();
}

function sequenceFromMotionDirectorPlan(plan) {
  const photosById = new Map(orderedPhotos().map((photo) => [photo.id, photo]));
  const scenes = plan.scenes.map((item, index) => {
    const photo = photosById.get(item.photoId);
    if (!photo) return null;
    return {
      id: `director-scene-${index + 1}`,
      type: "photo",
      order: index + 1,
      photo: {
        ...photo,
        category: mdRoomToSceneLabel(item.roomType),
        pipelineCategory: mdRoomToPipelineCategory(item.roomType)
      },
      category: mdRoomToPipelineCategory(item.roomType),
      caption: [item.overlay?.headline, item.overlay?.subline].filter(Boolean).join(" · "),
      duration: item.duration,
      role: "openai motion directed",
      directorScene: item
    };
  }).filter(Boolean);
  return {
    intro: { id: "intro", type: "intro", caption: plan.introCard?.headline || aiCopy().hook, duration: 2.2 },
    scenes,
    outro: { id: "outro", type: "outro", caption: plan.outroCard?.headline || state.project.cta || state.brandKit.ctaText, duration: 3 },
    totalDuration: Number((scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 5.2)).toFixed(1))
  };
}

function renderManifestScenes(sequence = createPipelineSequence()) {
  const scenes = sequence.scenes || [];
  const copy = aiCopy();
  const captionByScene = new Map(pipelineCaptions(sequence).map((item) => [item.sceneId, item.caption]));
  let beatCursor = 0;
  const music = selectedMusicTrack();
  const photoScenes = scenes.map((scene, index) => {
    const photo = scene.photo;
    const motion = motionPlanForPhoto(photo, index);
    const directorScene = scene.directorScene || state.project.motionDirectorPlan?.scenes?.find((item) => item.photoId === photo.id);
    const duration = Number(directorScene?.duration || scene.duration || motion.duration);
    const imageUrl = photoRenderUrl(photo);
    const durableUrl = photoDurableUrl(photo);
    const publicUrl = photo.publicUrl || photo.public_url || (!featureFlags.SUPABASE_STORAGE_PRIVATE ? durableUrl : "");
    const overlay = directorScene?.overlay || {};
    const sceneManifest = {
      order: index + 1,
      type: "photo",
      photoId: photo.id,
      fileName: photo.fileName,
      imageUrl,
      durableUrl,
      durable_url: durableUrl,
      publicUrl,
      public_url: publicUrl,
      sourceImageUrl: imageUrl,
      objectUrl: photo.objectUrl || "",
      durableUrlExpiresAt: photo.durableUrlExpiresAt || "",
      bucket: photo.bucket || featureFlags.LISTING_PHOTOS_BUCKET || "",
      storagePath: photo.storagePath || "",
      sceneType: mdRoomToSceneLabel(directorScene?.roomType) || motion.sceneType,
      roomType: directorScene?.roomType || sceneToPipelineCategory(photo.category),
      visibleFeatures: directorScene?.visibleFeatures || photo.visibleFeatures || photo.tags || [],
      qualityScore: directorScene?.qualityScore ?? sceneConfidence(photo),
      confidence: sceneConfidence(photo),
      duration,
      cameraMotion: directorScene?.cameraMotion || mdRenderMotionToCamera(motion.renderMotion || motion.motionStyle),
      motionStyle: mdCameraMotionLabel(directorScene?.cameraMotion) || motion.motionStyle || pipelineTemplateConfig().motionStyle,
      renderMotion: mdCameraMotionToRenderMotion(directorScene?.cameraMotion) || motion.renderMotion || motion.motionStyle || pipelineTemplateConfig().motionStyle,
      transition: mdTransitionToRenderTransition(directorScene?.transition) || motion.transition || pipelineTemplateConfig().transitionStyle,
      directorTransition: directorScene?.transition || "",
      beatMarker: motion.beatMarker,
      beatStart: Number(beatCursor.toFixed(2)),
      beatCut: Number((beatCursor + duration).toFixed(2)),
      musicTrackId: music.id,
      overlayText: overlay.headline || (index === 0 ? (sequence.intro?.caption || copy.hook) : (index === scenes.length - 1 ? (sequence.outro?.caption || captionByScene.get(scene.id) || motion.overlayText) : (captionByScene.get(scene.id) || motion.overlayText))),
      overlaySubline: overlay.subline || "",
      editPlanOverlay: overlay,
      introCard: index === 0 ? state.project.motionDirectorPlan?.introCard : null,
      outroCard: index === scenes.length - 1 ? state.project.motionDirectorPlan?.outroCard : null,
      branding: index === scenes.length - 1 ? "Personal brand end card" : "Subtle lower-third safe area",
      cta: index === scenes.length - 1 ? (sequence.outro?.caption || state.project.cta) : "",
      complianceFooter: state.brandKit.complianceEnabled ? state.brandKit.listingCourtesyOf : "",
      realismGuardrail: "Use only the uploaded photo. Do not hallucinate rooms, views, features, or objects."
    };
    beatCursor += duration;
    return sceneManifest;
  });
  return professionalRenderTimeline(photoScenes, sequence);
}

function professionalRenderTimeline(photoScenes = [], sequence = createPipelineSequence()) {
  const usablePhotos = photoScenes.slice(0, 25);
  const desiredPhotoSceneCount = Math.min(25, Math.max(15, usablePhotos.length || 0));
  const expandedPhotos = [];
  if (usablePhotos.length) {
    for (let index = 0; index < desiredPhotoSceneCount; index += 1) {
      const source = usablePhotos[index % usablePhotos.length];
      expandedPhotos.push({
        ...source,
        order: index + 3,
        repeatIndex: index,
        overlayText: index >= usablePhotos.length ? alternateSceneOverlay(source, index) : source.overlayText
      });
    }
  }
  const introDuration = 3.4;
  const statsDuration = 3.2;
  const outroDuration = 3.5;
  const targetSeconds = 54;
  const photoDuration = expandedPhotos.length
    ? Math.max(2, Math.min(3, (targetSeconds - introDuration - statsDuration - outroDuration) / expandedPhotos.length))
    : 2.8;
  let cursor = 0;
  const intro = {
    order: 1,
    type: "intro",
    sceneType: "Address intro",
    duration: introDuration,
    beatStart: cursor,
    beatCut: Number((cursor + introDuration).toFixed(2)),
    overlayText: state.project.address || sequence.intro?.caption || aiCopy().hook || "Featured Listing",
    overlaySubline: [state.project.price, state.project.city].filter(Boolean).join(" · "),
    cardLabel: selectedListingVideoStyleLabel(),
    transition: "light_leak",
    cameraMotion: "push_in"
  };
  cursor += introDuration;
  const stats = {
    order: 2,
    type: "stats",
    sceneType: "Property stats",
    duration: statsDuration,
    beatStart: Number(cursor.toFixed(2)),
    beatCut: Number((cursor + statsDuration).toFixed(2)),
    overlayText: [state.project.beds ? `${state.project.beds} Bed` : "", state.project.baths ? `${state.project.baths} Bath` : "", state.project.squareFeet ? `${state.project.squareFeet} Sq Ft` : ""].filter(Boolean).join(" | ") || "Property Details",
    overlaySubline: state.project.price || state.project.city || "",
    cardLabel: "Property facts",
    transition: "blur_wipe",
    cameraMotion: "pull_out"
  };
  cursor += statsDuration;
  const timedPhotos = expandedPhotos.map((scene, index) => {
    const duration = Number(photoDuration.toFixed(2));
    const timed = {
      ...scene,
      order: index + 3,
      duration,
      beatStart: Number(cursor.toFixed(2)),
      beatCut: Number((cursor + duration).toFixed(2)),
      beatMarker: `Beat ${index + 1}${index % 4 === 3 ? " / transition accent" : ""}`
    };
    cursor += duration;
    return timed;
  });
  return [intro, stats, ...timedPhotos].map((scene, index) => ({ ...scene, order: index + 1 }));
}

function alternateSceneOverlay(scene, index) {
  const options = [
    scene.overlayText,
    scene.overlaySubline,
    scene.featureCard,
    scene.sceneType ? `${scene.sceneType} detail` : "Property detail"
  ].filter(Boolean);
  return options[index % options.length] || scene.overlayText || "Property highlight";
}

function selectedListingVideoStyleLabel() {
  return listingVideoTemplates().find((item) => item.id === normalizeTemplateId(state.selectedTemplateId))?.label || selectedTemplate().name || "Cinematic Luxury";
}

function mdAllowedRoomTypes() {
  return ["exterior", "kitchen", "living", "bedroom", "bathroom", "outdoor", "amenity", "detail"];
}

function mdAllowedCameraMotions() {
  return ["push_in", "pull_out", "lateral_pan", "vertical_reveal", "parallax_zoom", "detail_sweep"];
}

function mdAllowedTransitions() {
  return ["crossfade", "blur_wipe", "whip_pan", "match_cut", "light_leak"];
}

function mdRoomType(photo = {}, index = 0) {
  const haystack = `${photo.fileName || ""} ${photo.category || ""}`.toLowerCase();
  if (/exterior|front|facade|house|home|curb/.test(haystack) || index === 0) return "exterior";
  if (/kitchen|island|cabinet|counter/.test(haystack)) return "kitchen";
  if (/living|family|great/.test(haystack)) return "living";
  if (/bed|primary|master/.test(haystack)) return "bedroom";
  if (/bath|shower|tub|vanity/.test(haystack)) return "bathroom";
  if (/yard|backyard|pool|patio|outdoor/.test(haystack)) return "outdoor";
  if (/gym|club|amenity|garage|view/.test(haystack)) return "amenity";
  return "detail";
}

function mdRoomRank(roomType) {
  return { exterior: 0, kitchen: 1, living: 2, bedroom: 3, bathroom: 4, outdoor: 5, amenity: 6, detail: 7 }[roomType] ?? 99;
}

function mdQualityScore(photo, index) {
  const pixels = Number(photo.width || 0) * Number(photo.height || 0);
  const resolution = pixels ? Math.min(18, Math.round(pixels / 180000)) : 8;
  return Math.max(45, Math.min(98, Math.round(92 - index * 3 + resolution - mdRoomRank(mdRoomType(photo, index)))));
}

function mdVisibleFeatures(photo, roomType) {
  const name = String(photo.fileName || "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return [name || mdRoomToSceneLabel(roomType), mdRoomToSceneLabel(roomType)].filter(Boolean).slice(0, 3);
}

function mdDuration(roomType, index) {
  const style = selectedListingVideoStyleLabel();
  const fast = /social|modern/i.test(style);
  if (index === 0) return fast ? 2.1 : 3.0;
  if (["kitchen", "living"].includes(roomType)) return fast ? 1.8 : 2.7;
  if (["detail", "bathroom"].includes(roomType)) return fast ? 1.4 : 2.0;
  return fast ? 1.65 : 2.35;
}

function mdCameraMotion(roomType, index) {
  if (index === 0) return "parallax_zoom";
  if (["kitchen", "living"].includes(roomType)) return "lateral_pan";
  if (roomType === "bathroom") return "vertical_reveal";
  if (roomType === "detail") return "detail_sweep";
  if (["outdoor", "amenity"].includes(roomType)) return "pull_out";
  return "push_in";
}

function mdTransition(roomType, index) {
  const style = selectedListingVideoStyleLabel();
  if (index === 0) return "crossfade";
  if (/social|modern/i.test(style)) return roomType === "kitchen" ? "whip_pan" : "match_cut";
  if (/luxury/i.test(style)) return index % 3 === 0 ? "light_leak" : "blur_wipe";
  return "crossfade";
}

function mdOverlay(roomType, index) {
  if (index === 0) return { headline: state.project.address || "Featured listing", subline: [state.project.price, state.project.city].filter(Boolean).join(" · ") };
  const labels = { exterior: "Curb appeal", kitchen: "Kitchen", living: "Living space", bedroom: "Bedroom", bathroom: "Bath", outdoor: "Outdoor living", amenity: "Amenity", detail: "Design detail" };
  return {
    headline: labels[roomType] || "Property detail",
    subline: [state.project.beds ? `${state.project.beds} bed` : "", state.project.baths ? `${state.project.baths} bath` : "", state.project.squareFeet ? `${state.project.squareFeet} sq ft` : ""].filter(Boolean).join(" · ")
  };
}

function mdRoomToPipelineCategory(roomType) {
  return {
    exterior: "exterior hero",
    kitchen: "kitchen",
    living: "living room",
    bedroom: "bedroom",
    bathroom: "bathroom",
    outdoor: "backyard/outdoor",
    amenity: "amenity",
    detail: "detail/other"
  }[roomType] || "detail/other";
}

function mdPipelineCategoryToRoomType(category) {
  const value = String(category || "").toLowerCase();
  if (value.includes("exterior")) return "exterior";
  if (value.includes("kitchen")) return "kitchen";
  if (value.includes("living")) return "living";
  if (value.includes("bed")) return "bedroom";
  if (value.includes("bath")) return "bathroom";
  if (value.includes("backyard") || value.includes("outdoor") || value.includes("pool")) return "outdoor";
  if (value.includes("amenity") || value.includes("neighborhood")) return "amenity";
  return "detail";
}

function mdRoomToSceneLabel(roomType) {
  return {
    exterior: "Exterior hero",
    kitchen: "Kitchen",
    living: "Living room",
    bedroom: "Primary bedroom",
    bathroom: "Bathroom",
    outdoor: "Backyard / pool",
    amenity: "Neighborhood / amenities",
    detail: "Detail shots"
  }[roomType] || "";
}

function mdCameraMotionToRenderMotion(cameraMotion) {
  return {
    push_in: "Push-in",
    pull_out: "Pull-out",
    lateral_pan: "Slow pan",
    vertical_reveal: "Vertical social framing",
    parallax_zoom: "Depth zoom",
    detail_sweep: "Orbit simulation"
  }[cameraMotion] || "";
}

function mdCameraMotionLabel(cameraMotion) {
  return {
    push_in: "Push-in",
    pull_out: "Pull-out",
    lateral_pan: "Lateral pan",
    vertical_reveal: "Vertical reveal",
    parallax_zoom: "Parallax zoom",
    detail_sweep: "Detail sweep"
  }[cameraMotion] || "";
}

function mdRenderMotionToCamera(renderMotion) {
  const value = String(renderMotion || "").toLowerCase();
  if (value.includes("pull")) return "pull_out";
  if (value.includes("pan")) return "lateral_pan";
  if (value.includes("vertical")) return "vertical_reveal";
  if (value.includes("orbit")) return "detail_sweep";
  if (value.includes("depth")) return "parallax_zoom";
  return "push_in";
}

function mdTransitionToRenderTransition(transition) {
  return {
    crossfade: "soft dissolve",
    blur_wipe: "blur wipe",
    whip_pan: "whip pan",
    match_cut: "match cut",
    light_leak: "light leak"
  }[transition] || "";
}

function isLocalOnlyUrl(url = "") {
  const value = String(url || "").toLowerCase();
  return !value || value.startsWith("blob:") || value.startsWith("data:") || value.includes("localhost") || value.includes("127.0.0.1");
}

function buildExportPayload() {
  const sequence = createPipelineSequence();
  const music = selectedMusicTrack();
  return {
    app: "EstateMotion",
    product: "Professional real estate listing video renderer",
    createdAt: new Date().toISOString(),
    project: state.project,
    brandKit: state.brandKit,
    template: selectedTemplate(),
    stylePack: templatePipelineId(),
    renderer: {
      engine: "Remotion",
      motionSystem: "deterministic-still-photo-depth-simulation",
      editPlanSource: state.project.motionDirectorPlan?.source || "deterministic-fallback",
      editPlanId: state.project.motionDirectorPlan?.id || "",
      noHallucinatedPropertyFeatures: true,
      futureProviders: ["Runway", "Luma", "Pika", "Replicate", "custom-depth-model"]
    },
    editPlan: state.project.motionDirectorPlan || null,
    previewContract: {
      source: "The browser preview uses the same scenes, image URLs, camera motions, transitions, overlays, durations, and beat markers sent to Remotion.",
      brandedVariants: ["vertical-branded", "wide-branded", "square-branded"],
      unbrandedVariants: ["vertical-unbranded", "mls-clean"],
      authenticity: "All visual property content comes from uploaded listing photos."
    },
    musicTiming: {
      track: music,
      beatMarkers: beatSyncPlan(renderManifestScenes(sequence)).beatMarkers,
      fallback: music.fallback || ""
    },
    formats: [
      { id: "vertical-branded", width: 1080, height: 1920, aspectRatio: "9:16", branded: true },
      { id: "vertical-unbranded", width: 1080, height: 1920, aspectRatio: "9:16", branded: false },
      { id: "wide-branded", width: 1920, height: 1080, aspectRatio: "16:9", branded: true },
      { id: "square-branded", width: 1080, height: 1080, aspectRatio: "1:1", branded: true },
      { id: "mls-clean", width: 1920, height: 1080, aspectRatio: "16:9", branded: false, mlsSafe: true }
    ],
    scenes: renderManifestScenes(sequence)
  };
}

maybeStartOnboarding();
render();
bootstrapSupabase();
