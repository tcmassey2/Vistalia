import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "../lib/store";
import { createOrganization, fetchOrgRoster, fetchOrgAuditLog } from "../lib/api";
import type { OrgAuditLogEntry, OrgRosterMember } from "../lib/types";
import { cn } from "../lib/cn";
import { engineLabel } from "../lib/engine-labels";

/**
 * BrokerageScreen — the brokerage admin surface.
 *
 * Three states:
 *   1. Not yet a member of any org → shows the "Create your brokerage" form
 *      so any agent can stand up an org for their firm and become its owner.
 *   2. Member but not admin → shows a read-only "You're an agent at X" card
 *      with the org's compliance footer they're operating under.
 *   3. Owner / admin → roster + audit log, the actual admin dashboard.
 */
export default function BrokerageScreen() {
  const organization = useStore((s) => s.organization);
  const organizationLoaded = useStore((s) => s.organizationLoaded);

  if (!organizationLoaded) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-center">
        <span className="spinner mx-auto" />
        <p className="text-sm text-ink-muted mt-3">Loading your brokerage…</p>
      </div>
    );
  }

  if (!organization) {
    return <CreateOrganizationCard />;
  }

  const isAdmin = organization.role === "owner" || organization.role === "admin";
  return (
    <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col gap-10">
      <BrokerageHeader />
      {isAdmin ? <AdminDashboard /> : <AgentMembershipCard />}
    </div>
  );
}

/* ============================================================
   Create-org flow — first agent in a firm bootstraps the brokerage.
   ============================================================ */
function CreateOrganizationCard() {
  const setOrganization = useStore((s) => s.setOrganization);
  const setToast = useStore((s) => s.setToast);
  const setError = useStore((s) => s.setError);

  const [name, setName] = useState("");
  const [state, setState] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const org = await createOrganization({ name, state, licenseNumber });
      setOrganization(org);
      setToast("Brokerage created — you're the owner.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create brokerage.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="text-center mb-8">
        <p className="text-xs uppercase tracking-wider text-gold mb-2 font-mono">Brokerage</p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tighter2 mb-3">
          Run your brokerage from here.
        </h1>
        <p className="text-sm text-ink-muted max-w-lg mx-auto leading-relaxed">
          Add your firm and you'll see every video your agents produce under the license,
          with a built-in audit trail your compliance officer will actually like.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="bg-surface border border-edge rounded-2xl p-6 sm:p-8 flex flex-col gap-5"
      >
        <Field label="Brokerage name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pinnacle Peak Realty"
            required
            className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="State">
            <input
              value={state}
              onChange={(e) => setState(e.target.value.toUpperCase())}
              maxLength={2}
              placeholder="AZ"
              className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim uppercase font-mono focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
            />
            <p className="text-[11px] text-ink-muted mt-1">Drives state-specific compliance overlays.</p>
          </Field>
          <Field label="Brokerage license #">
            <input
              value={licenseNumber}
              onChange={(e) => setLicenseNumber(e.target.value)}
              placeholder="DRE# 01234567"
              className="h-11 px-3.5 bg-surface-input border border-edge rounded-lg text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
            />
            <p className="text-[11px] text-ink-muted mt-1">Stamped on every video produced under your firm.</p>
          </Field>
        </div>

        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="btn-primary-em h-11 px-5 mt-2 rounded-lg disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          {busy ? <><span className="spinner" /> Creating…</> : "Create brokerage"}
        </button>

        <p className="text-xs text-ink-muted text-center -mt-1">
          You can change every detail later from the admin dashboard.
        </p>
      </form>
    </div>
  );
}

/* ============================================================
   Header that the admin dashboard sits under
   ============================================================ */
function BrokerageHeader() {
  const organization = useStore((s) => s.organization);
  if (!organization) return null;
  const tierLabel: Record<string, string> = {
    team: "Team Brokerage",
    brokerage: "Brokerage Pro",
    enterprise: "Enterprise"
  };
  return (
    <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 pb-6 border-b border-edge-soft">
      <div>
        <p className="text-xs uppercase tracking-wider text-gold mb-2 font-mono">
          {tierLabel[organization.tier] || "Brokerage"}
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tighter2">{organization.name}</h1>
        <p className="text-sm text-ink-muted mt-1.5">
          {[
            organization.state,
            organization.licenseNumber,
            `${organization.agentSeatCount}/${organization.agentSeatCap} seats`
          ].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RoleBadge role={organization.role} />
      </div>
    </header>
  );
}

function RoleBadge({ role }: { role: "owner" | "admin" | "agent" }) {
  const styles = {
    owner: "bg-gold text-paper",
    admin: "bg-gold/20 text-gold-light border border-gold/40",
    agent: "bg-edge text-ink-muted border border-edge-strong"
  };
  return (
    <span className={cn("text-[10px] font-bold tracking-widest uppercase px-2 py-1 rounded", styles[role])}>
      {role}
    </span>
  );
}

/* ============================================================
   Agent-level card — when an agent is in a brokerage but not admin
   ============================================================ */
function AgentMembershipCard() {
  const organization = useStore((s) => s.organization);
  if (!organization) return null;
  return (
    <div className="bg-surface border border-edge rounded-2xl p-6 sm:p-8 max-w-xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tightish mb-2">You're producing under {organization.name}</h2>
      <p className="text-sm text-ink-muted leading-relaxed">
        Every video you render is audit-logged for your brokerage. Your videos automatically
        carry the firm's compliance footer{organization.licenseNumber ? ` (${organization.licenseNumber})` : ""}.
      </p>
      <p className="text-xs text-ink-dim mt-4">
        Need owner / admin access? Ask your brokerage owner to update your role.
      </p>
    </div>
  );
}

/* ============================================================
   Admin dashboard — roster + audit log
   ============================================================ */
function AdminDashboard() {
  const [roster, setRoster] = useState<OrgRosterMember[] | null>(null);
  const [auditLog, setAuditLog] = useState<OrgAuditLogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [rosterRes, auditRes] = await Promise.all([fetchOrgRoster(), fetchOrgAuditLog({ limit: 50 })]);
        if (!alive) return;
        setRoster(rosterRes);
        setAuditLog(auditRes);
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : "Could not load brokerage data.";
        setErrorMsg(msg);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="text-center py-16">
        <span className="spinner mx-auto" />
        <p className="text-sm text-ink-muted mt-3">Loading brokerage data…</p>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className="bg-surface border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
        {errorMsg}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-8">
      <RosterPanel roster={roster || []} />
      <AuditLogPanel auditLog={auditLog || []} />
    </div>
  );
}

function RosterPanel({ roster }: { roster: OrgRosterMember[] }) {
  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-base font-semibold tracking-tightish">Roster</h2>
        <p className="text-xs text-ink-muted">{roster.length} agent{roster.length === 1 ? "" : "s"}</p>
      </header>
      <div className="bg-surface border border-edge rounded-xl divide-y divide-edge-soft">
        {roster.map((member) => (
          <div key={member.userId} className="px-4 py-3 flex items-center gap-3">
            <div className="grid place-items-center w-8 h-8 rounded-full bg-gold/15 text-gold text-xs font-semibold">
              {(member.fullName || member.email).slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {member.fullName || member.email || "Agent"}
              </div>
              <div className="text-xs text-ink-muted truncate">
                {member.email} · <span className="font-mono uppercase">{member.role}</span>
              </div>
            </div>
            <div className="text-xs text-ink-soft text-right whitespace-nowrap">
              <div className="font-mono">{member.rendersLast30Days}</div>
              <div className="text-[10px] text-ink-muted">last 30d</div>
            </div>
          </div>
        ))}
        {roster.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-ink-muted">
            No agents yet. Invite flow ships next session.
          </div>
        )}
      </div>
    </section>
  );
}

function AuditLogPanel({ auditLog }: { auditLog: OrgAuditLogEntry[] }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tightish">Render audit log</h2>
          <p className="text-xs text-ink-muted">Every video produced under your license, in real time.</p>
        </div>
        <span className="text-xs text-ink-muted">{auditLog.length} entries</span>
      </header>

      {auditLog.length === 0 ? (
        <div className="bg-surface border border-edge rounded-xl p-8 text-center">
          <div className="text-sm text-ink-muted">
            No renders yet. The first video your agents produce shows up here automatically.
          </div>
        </div>
      ) : (
        <div className="bg-surface border border-edge rounded-xl overflow-hidden">
          <div className="divide-y divide-edge-soft">
            {auditLog.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function AuditRow({ entry }: { entry: OrgAuditLogEntry }) {
  const date = new Date(entry.createdAt);
  const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timeLabel = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="px-4 py-3 flex items-center gap-4">
      <a
        href={entry.mp4Url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-16 aspect-video bg-black rounded overflow-hidden flex-shrink-0 group"
      >
        {entry.thumbnailUrl ? (
          <img src={entry.thumbnailUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
        ) : (
          <div className="w-full h-full bg-edge" />
        )}
      </a>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {entry.listingAddress || entry.projectTitle || "Untitled listing"}
        </div>
        <div className="text-xs text-ink-muted truncate">
          {[entry.agentDisplayName || entry.agentEmail, engineLabel(entry.engine)]
            .filter(Boolean)
            .join(" · ")}
          {entry.narrationApplied && <span className="text-gold ml-2">· narrated</span>}
        </div>
      </div>
      <div className="text-right whitespace-nowrap">
        <div className="text-xs text-ink-soft">{dateLabel}</div>
        <div className="text-[10px] text-ink-muted">{timeLabel}</div>
      </div>
      {entry.mp4Url && (
        <a
          href={entry.mp4Url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gold hover:text-gold-light transition-colors"
        >
          View →
        </a>
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-soft">
        {label}{required && <span className="text-gold ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
