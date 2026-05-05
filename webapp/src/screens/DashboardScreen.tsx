import { useStore } from "../lib/store";
import { buildSamplePhotos, SAMPLE_LISTING, SAMPLE_PROJECT_TITLE } from "../lib/samples";

export default function DashboardScreen() {
  const projects = useStore((s) => s.projectList);
  const newProject = useStore((s) => s.newProject);
  const session = useStore((s) => s.session);
  const setListing = useStore((s) => s.setListing);
  const addPhotos = useStore((s) => s.addPhotos);
  const setProjectTitle = useStore((s) => s.setProjectTitle);

  const firstName = (session?.user?.email || "there").split("@")[0];

  const startWithSample = () => {
    newProject();
    // After newProject() the editor is open with a fresh blank project.
    // Inject the sample data.
    setListing(SAMPLE_LISTING);
    setProjectTitle(SAMPLE_PROJECT_TITLE);
    addPhotos(buildSamplePhotos());
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 mb-10">
        <div>
          <p className="text-xs uppercase tracking-wider text-gold mb-2 font-mono">Dashboard</p>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tighter2">
            Welcome back, {firstName}.
          </h1>
          <p className="text-ink-muted text-sm mt-2">
            Start a new listing video, or pick up where you left off.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <button
            onClick={startWithSample}
            className="btn-secondary-em h-11 px-4 rounded-lg text-sm"
          >
            Try with sample listing
          </button>
          <button
            onClick={newProject}
            className="btn-primary-em h-11 px-5 rounded-lg inline-flex items-center gap-2"
          >
            <span className="text-lg leading-none">+</span> New listing video
          </button>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="border border-edge rounded-2xl bg-surface px-8 py-16 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-gold/10 grid place-items-center mb-5">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-gold" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold mb-2">No videos yet</h2>
          <p className="text-ink-muted text-sm max-w-md mx-auto mb-6">
            Upload a listing's photos and EstateMotion produces a cinematic walkthrough in under three minutes.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={newProject}
              className="btn-primary-em h-11 px-5 rounded-lg"
            >
              Create your first video
            </button>
            <button
              onClick={startWithSample}
              className="btn-secondary-em h-11 px-5 rounded-lg"
            >
              Try sample listing
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} {...p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  id,
  title,
  thumbnailUrl,
  status,
  createdAt
}: {
  id: string;
  title: string;
  thumbnailUrl: string;
  status: "draft" | "rendering" | "complete";
  createdAt: string;
}) {
  const openProject = useStore((s) => s.openProject);
  return (
    <button
      onClick={() => openProject(id)}
      className="card-press group text-left bg-surface border border-edge hover:border-edge-strong rounded-xl overflow-hidden"
    >
      <div className="aspect-video bg-surface-input relative overflow-hidden">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-ink-dim text-xs">
            No preview
          </div>
        )}
        <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-paper/85 text-[10px] font-mono uppercase tracking-wider text-ink-soft border border-edge">
          {status}
        </span>
      </div>
      <div className="p-4">
        <h3 className="font-medium tracking-tightish truncate">{title}</h3>
        <p className="text-xs text-ink-muted mt-1">{new Date(createdAt).toLocaleDateString()}</p>
      </div>
    </button>
  );
}
