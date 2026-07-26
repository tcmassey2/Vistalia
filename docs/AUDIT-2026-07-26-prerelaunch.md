# Vistalia render pipeline — pre-relaunch audit

**Tree audited:** `dfa6531` (= origin/main = what deploys). Working tree clean, nothing unpushed.
**Method:** six adversarial auditors run in parallel over a byte-verified snapshot (one per subsystem: plan/narration, worker orchestration, audio chain, queue/infra, import/webapp, seams/engines), each executing code rather than reading comments — then every headline claim independently re-verified against the real repo before it entered this report. Baseline first: all 5 test suites green (219 assertions).

---

## Verdict: NO-GO until the gates below are closed — then GO.

The core render path is in better shape than the incident history suggests: the claim protocol, the voice-first machinery, the square pipeline, the fps path, the fal hardening, and the v62.35/36 changes all survived adversarial verification (details in "What held"). What gates relaunch is not the pipeline — it's five things around it: an open queue surface, two money seams, three of my own recent commits that shipped inert, and a lockfile that breaks fresh deploys.

**Split:** items marked **[me — fixing now]** land in v62.37 today. Items marked **[you]** need your hands (Supabase SQL, Render/Vercel dashboards) — the exact commands/queries are in the operator checklist at the end.

---

## Corrections first

Two loud findings from the worker auditor — *warp.onnx missing* (homography floor dead, all floors secretly zoompan) and *caption/title fonts missing* — are **false alarms**. My audit snapshot stripped binaries; I re-checked the real repo: `render-worker/assets/warp.onnx`, both Vistalia TTFs, and all music mp3s are tracked in git and ship in the Docker image. The floor you tuned in v62.35 is the floor that runs.

What survives from those findings: the **zoompan fallback** floor (used only if onnxruntime itself fails at runtime) has no duration compensation — same 8.8s-slideshow defect the homography floor had. Low priority, listed in P2.

---

## P0 — relaunch gates

**1. The queue is callable with the anon key.** `claim_render_job`, `requeue_stuck_render_jobs`, and `prune_old_render_jobs` are SECURITY DEFINER with no REVOKE (unlike migrations 12/15, which did it right), and `canary_state` has no RLS. Anyone with the browser-shipped anon key can claim customer jobs — receiving the full manifest (photos, address, userId) — and each theft stalls the customer 4–9 min and burns one of 3 attempts; three thefts fail the job with no refund. **[me]** migration `36_lock_queue_surface.sql` in v62.37. **[you]** apply it, then run the anon-key probe in the checklist to confirm denial.

**2. Money seams.** (a) A job failed by the reaper's 3-strike rule is charged and never refunded — the only refund caller is the worker's in-process catch, which by definition didn't run. (b) Terminal status writes are unfenced last-write-wins: a refunded-then-zombie-completed job is reachable (the 25-min cap's `Promise.race` doesn't cancel the loser — the code comments admit it uploads anyway), and a reaper-redelivered job can be completed twice with two emails (notify has no per-job dedupe). **[me]** migration `37_reaper_refunds.sql` drafted — **REVIEW BEFORE APPLYING, it touches credits**. **[you]** run the reconciliation query in the checklist to refund historical 3-strike victims; decide on the migration. The write-fencing (`worker_instance_id` on terminal PATCHes) is queued as the first post-relaunch worker change.

**3. v62.36 shipped dead — `targetDurationSec` never reaches the worker.** The webapp passes it to the *plan* request but never puts it on the *manifest*; canary and lead-auto-render manifests lack it too. So the duration contract I shipped Friday has never once run, `audit-log` has been recording `targetDurationSec: null` forever, the Library "Length" row is blank — and, worse, the v49 **free-trial 30s cap in render.js can never fire** (`0 > 30`), so trial accounts can burn 60s renders. Mine. **[me — fixing now]** in webapp manifest + type + canary + lead lanes.

**4. v62.32 shipped ineffective — the curation gate awaits, then uses the pre-curation photos anyway.** `generate()` awaits `pendingCuration`, but the plan and manifest are built from the `photos` **closure captured at click time**; the curated order lands in the store and is never re-read. The Jul 26 four-kitchen render is delayed 45s, not fixed. Bonus: a curation resolving after the 45s ceiling reorders the photo grid mid-render. Mine. **[me — fixing now]** re-read store after the await; consume the promise so late resolution can't mutate mid-render; clear it on project switch.

**5. Zillow fail-open now imports other homes' photos at full resolution** (v62.23 regression — mine). When Zillow's markup changes and gallery-hash extraction finds nothing, the code keeps ALL `/fp/` URLs — including the related-homes carousel — and my unconditional variant rewrite upgrades their 316×234 thumbs to `cc_ft_1536`, defeating the low-res gate that used to catch exactly this. One markup change away from "someone else's house in the customer's tour." **[me — fixing now]** fail-open keeps only URLs that were already gallery-tier variants.

**6. No server-side manifest clamps.** The render manifest is client-constructed and `validateManifestForServerRender` checks per-scene URLs only: a hand-built `targetDurationSec: 5` would (once gate 3 is fixed) trim a paid render to a ~7s stub; scene count is unbounded until the worker's belt at 30 (≈$36 of fal per 1–2 credits, and the 10/hr rate limit is per-Vercel-instance in memory); plain `http://` image URLs pass and are fetched server-side. **[me — fixing now]** clamp `targetDurationSec` to [15,60], reject >30 photo scenes, require https + non-local hosts on live renders.

**7. Fresh worker deploys are broken/floating.** `render-worker/package-lock.json` is out of sync: `sharp`, `onnxruntime-node`, and `@fal-ai/client` aren't in it at all — `npm ci` hard-fails (the README's own instruction), and the Dockerfile survives via `npm install`, which re-resolves both boot-critical native modules on every deploy (onnxruntime ^1.20 floats to 1.23 today). The relaunch scenario *is* a fresh deploy. **[me — fixing now]** regenerate the lockfile + add engine pins. **[you]** one Docker build to confirm before relying on it.

Also in v62.37 while I'm in there: the **worker-secret precedence inversion** (api prefers `RENDER_WEBHOOK_SECRET`, worker prefers `RENDER_WORKER_SECRET` — both set to different values = every render 401s; neither set = worker accepts unauthenticated jobs). I'm aligning the order; **[you]** set one secret, same value, both hosts.

---

## P1 — first week after relaunch

**Regen of a voice-first original is broken in six ways** (the `regenerate-job.mjs:205` "KNOWN SEAM" is worse than its own label): it rebuilds narration from the *posted* manifest's scene list, so any v62.36-trimmed or mid-render-dropped scene becomes a ghost that shifts every later line onto the wrong room; a **trial regen overwrites the watermarked master with an unmarked one** (free watermark removal); a regen followed by the $39 unlock serves the **pre-regen** clean master with the bad scene back; caption on/off and skin are ignored (defaults luxury-on); every AI regen adds +0.5s to its scene (compounding per regen, 5/10s quantization on the Ken Burns mode); regen ships three "shorts" the original never had, cut at wrong offsets. The replacement clip also gets **no QC** — the hallucination-fix path is the one uninspected path. *Recommendation: disable regen for voice-first originals at relaunch (one guard), fix the cluster properly next — the auditor's sketch is to reconcile regen against the audit row's scene list instead of the posted manifest.*

**Timeout architecture is inverted, and lost races don't cancel.** A caption burn is capped at 240s inside a 120s mix budget; the 150s voice-first budget contains a ladder that can legitimately take ~300s. A slow-but-healthy burn loses the race → legacy re-synthesizes (second ElevenLabs spend) → loses its race too → ships music-only, with two orphaned encodes still running. Thread an AbortSignal through, and make outer ≥ inner.

**The drift gate sums bookkeeping, not media.** `actualDurationsByPhoto` carries the *ask*, never a probe — so a provider under-delivering, compensating ±0.6s errors, or the concat-fallback stitch (hard cuts, no 0.5s consumed → master runs long by 0.5×(N−1)s) all pass at drift 0.00 and desync silently. Probe the normalized clips (or the master) instead.

**The "18-minute cap" is a myth the code still budgets against.** Real cap: 25 min ≤10 scenes, +2.5/extra, max 55 (`server.mjs:764`), while `/version` advertises 18min and several internal budgets reason from it. Separately, one sweep replacement triggers a restitch that **re-normalizes every clip** (~5–10 min on a 9-scene render) — a 2-flag render lands ~22–28 min, and on cap the refunded job zombie-completes. Re-normalize only replaced clips; reconcile the label.

**Lifecycle gaps:** SIGTERM is swallowed (log-only handler — a draining deploy instance keeps claiming jobs until SIGKILL; the Jul 24 incident shape); the heartbeat ticker is fire-and-forget with no timeout and no failure log (a >4-min Supabase brownout can get the whole in-flight fleet reaped); the 12-min watchdog `process.exit(1)` kills the *other* concurrent render too; regen's dedupe fails open into an upsert that can reset a **live** job to `queued` (double-render); migration 35's reaper dropped migration 25's `heartbeat_at = null` reset, so a redelivered job carries a stale heartbeat and can be re-reaped in the claim window.

**The lead-auto-render lane** — the flagship "drop a link, get a render in your inbox" flow — gets **no curation** (raw portal order by construction; the v62.32 gate exists only in the webapp) and **no voice-first** (its manifest omits `narration`), so the inbox render is the stiffest version of the product.

---

## P2 — soon, not blocking

- **v62.35 room-check false positives** (mine): `"6-bedroom"` in a stats hook reads as a bedroom claim (hyphenated form dodges my "no bare bed" guard); `"living area"` isn't in the living vocabulary; `"overlooking the backyard"` claims outdoor. Two of these in one script demote a correct Director monologue — and the audit fixture shows exactly that happening on the real Jul-25 127-word script. Fix the two patterns, and exclude `\d+[-\s](bed|bath)`.
- **Scene-budget trim orphans a sentence** (pre-`attachNarration`, when the Director returns target+1 scenes): the dropped scene's sentence survives as a linger narrating the wrong room — the v62.31 class, one stage earlier. Same fix, earlier site.
- **Plan word band vs worker ceiling are incoherent**: 86 words (the plan trim's own output ceiling) always triggers the worker trim once gate 3 lands; ~half of in-band scripts trim at typical pace. Not harmful (the video lands on the order — that's the feature) but wasteful. Retune the band with the CALIBRATION log line v62.36 now emits from real renders.
- **Progress honesty**: ETA constant 620s vs ~950s reality; the bar freezes at 15% for the whole voice-first + first-clip window (worker restarts at 7); the 78–94% tail stalls flat "3 min left" for minutes; "Adding voice narration" appears twice. This is the "stuck at 80%" complaint, front and back halves.
- **Caption edges**: a 1-word page can double-draw over the next page (min-display floor vs clamp); the per-line fallback path has **no 502 retry** (one transient error = permanently silent scene) and **burns no captions at all**; wide (16:9) masters get 170px captions; crossfades-off configs drift floors +0.5s each.
- Misc: 4K tier silently downgraded to 1080p (v23.2 block still in); `GET /api/render` status has no ownership check (guessable jobIds leak mp4 URLs); audit-log records no trim telemetry (the "why is my video 28s" evidence); `/version` lies about model/resolution/cap; `FAL_RESOLUTION` defaults conflict (720p vs 1080p across files); `MAX_OPENAI_BATCH` computed but never enforced; `requestedFormat` accepted and ignored on the AI path; `buildTitleIntro` ignores its style param (MLS Clean gets the serif); `.env.example` covers 33 of ~140 vars; **two migrations are numbered 34**; re-running `PROD_CATCHUP_20260701.sql` would silently revert the reaper to pre-v62.34 semantics; `factsFromHtml` can pick another listing's price off portal pages (provenance-blind first-match, overrides RentCast).

---

## What held (verified sound, not just unflagged)

The claim protocol is genuinely atomic (`FOR UPDATE SKIP LOCKED` — double-claim disproven; every observed duplicate was redelivery, not the primitive). Per-job refund idempotency holds (unique job_id + refunded flag — one job can never refund twice). Poll single-flight/backoff can't stick. The fal client is properly hardened (semaphore with slot handoff, transient-vs-terminal 429s, subscribe/download/attempt deadlines, stall breaker). The 24→30fps path probes rather than assumes, and every route into the stitcher is 30fps CFR. Square is native end-to-end with no residual 9:16 hardcodes on the happy path. The v62.36 trim internals survived a dedicated attack (atomic commit-after-proof, measured-cut guard live-refusing an overrunning span, keepOrdinals validated before any deletion, captions/ducks rebuilt post-trim — the m66 class cannot occur). The mixer's arithmetic closes in closed form and measured 0.00 drift live. `deliveryDims` is present and consumed in all three mixer paths (the v62.18 ReferenceError class is dead). ASS escaping strips injection. The worker boots with zero env and degrades per-feature (no import-time crash). No synchronous block >30s exists (heartbeat starvation fears unfounded — the risk is network, not the event loop). Temp hygiene within a job is clean post-v62.17. The **Veo rollback engine works** — flipping `FAL_VIDEO_MODEL` back at 2am functions, with correct bucketing, loud 1:1 degrade, probed fps (residuals: `/version` misreports it; `RUNWAY_API_KEY` untested since June). Voice-first's gates all fail closed *before* spend. Lint: 66/66 files clean. All 5 suites: 219/219.

---

## Operator checklist (before flipping traffic back on)

**Supabase (SQL editor):**
1. Apply migration 36, then with the **anon key**: `POST /rest/v1/rpc/claim_render_job` → must be denied.
2. `select proname, proacl from pg_proc where proname in ('claim_render_job','requeue_stuck_render_jobs','prune_old_render_jobs');` — confirm revokes stuck.
3. `select prosrc from pg_proc where proname='requeue_stuck_render_jobs';` — must contain `interval '4 minutes'` (i.e. migration 35 is live and PROD_CATCHUP wasn't re-run after it). Confirm both migrations numbered 34 applied.
4. `select relname, relrowsecurity from pg_class where relname in ('canary_state','render_jobs');` — canary_state true after 36.
5. Refund reconciliation (historical 3-strike victims):
   `select j.job_id, j.user_id, j.error from render_jobs j left join render_credit_refunds r using (job_id) where j.status='failed' and j.error like '%max attempts%' and r.job_id is null;` — refund these; review migration 37 for the ongoing fix.
6. `select job_id, count(*) from render_audit_log group by 1 having count(*)>1;` — double-render evidence, baseline before relaunch.

**Render.com:**
7. Instance count + autoscaling range (every instance runs a reaper; FAL_MAX_CONCURRENCY should be your fal plan limit ÷ max instances). SIGTERM→SIGKILL grace setting. `RENDER_GIT_COMMIT` populated, `CANARY_USER_ID` set (canary has no redelivery protection without it), `CRON_SECRET` set (canary dark without it), `GEMINI_API_KEY` or `OPENAI_API_KEY` on the worker (QC + sweep silently dark otherwise), ELEVENLABS key with v3 + forced-alignment (the log's `rung=` line tells you which fired).
8. One worker secret, same value, both hosts (after v62.37 the precedence agrees; today mismatched values = every render 401s).
9. Docker build once with the v62.37 lockfile; confirm boot log shows onnx floor + fonts found.

**Drills (one evening, one test render each):**
10. Watch `render_jobs.heartbeat_at` advance ~60s through all phases. Then `kill -9` the worker mid-render: requeue in 4–9 min, exactly one video + one email after redelivery. Watch the fal dashboard for duplicate scene generations — the direct double-spend evidence.
11. Deploy mid-render: old instance's job resumes once; look for "re-dealt while THIS worker is still rendering" lines.
12. Hostile probes with a test account: `targetDurationSec: 5` and a 25-scene manifest → both rejected after v62.37.

---

*Fleet: 6 auditors, ~1.5M tokens, every BROKEN claim re-verified against the real tree (two corrected as snapshot artifacts). Baseline: narration 142, import 34, duration 41, worker grid + e2e — all green on dfa6531.*
