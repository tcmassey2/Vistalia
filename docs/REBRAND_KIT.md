# EstateMotion → Rebrand Kit

June 19, 2026. Everything to pick a name and change it cleanly, keeping the LLC + EIN
you just filed. Not legal/tax advice — verify the state form/fee with the AZ Corporation
Commission and the IRS step with current IRS guidance. Knockouts below are preliminary
(web search), NOT a clearance — your trademark attorney runs the real USPTO + common-law
search before you commit.

## 1. Shortlist (clean knockout + .ai open)

| Name | Keeps | .ai | .com | Knockout | Notes |
|---|---|---|---|---|---|
| **Tourmotion** | Motion | open | parked | clean | Top pick — clean name + likely-clean handles. "Property tours in motion." |
| **Roomotion** | Motion | open | taken | clean (TM) | Strong, but @roomotion IG taken (small studio) + "Ramotion" soundalike agency. |
| **Suitemotion** | Motion | open | taken | clean | Luxury-suite feel. |
| **Reelhaus** | (reel) | open | taken | clean | Modern/distinct, but drops the Estate/Motion DNA. |

### Killed (don't use)
- **Estatik** — established real-estate WordPress plugin (estatik.net). Same industry.
- **EstateFrame** — active UK real-estate brand "EstateFrame".
- **Homotion** — tied to Somfy (home automation).
- **DwellReel** — "Dwell" is a crowded trademark family (Dwell mag, Dwell Residential).
- **Showmotion** — soundalike stage-automation company.
- reelty / reelestate / tourly / spacemotion / listora / motionly — .ai taken.

### Final step before committing (manual, ~5 min)
Reserve the handle on every platform at once for your pick — IG, TikTok, X, YouTube,
Facebook, LinkedIn — ideally the bare name; fall back to `get<name>` / `<name>hq` /
`<name>.ai` consistently. Grab `<name>.ai` (and `.com` if open) the same sitting.

---

## 2. How to change it — keep the LLC + EIN

**Your EIN does NOT change and is NOT wasted.** An EIN is permanent and tied to the
entity, not the name. The IRS does not issue a new EIN for a name change. Two paths:

- **Option A — DBA (fastest):** keep "EstateMotion LLC" as the legal entity; register a
  trade name "Vistalia". Public brand = Vistalia; EIN + Stripe untouched. ~$10–100.
- **Option B — Amend the LLC name (cleanest, recommended since you just formed it):**
  rename the LLC to "Vistalia LLC" with the state; EIN stays the same; notify the IRS.

Because nothing is attached yet (no contracts, Stripe not live), **Option B** gets the
entity, EIN, Stripe, and brand all consistent from day one.

---

## 3. Arizona LLC name change — checklist (Option B)

You're in Scottsdale → **Maricopa County**, which is exempt from the newspaper-publication
step, so this is short.

1. **Confirm the new name is available** on the AZ Corporation Commission (ACC) name
   database: ecorp.azcc.gov → Search Entities. Name must end in "LLC" / "L.L.C." and be
   distinguishable from existing AZ entities.
2. **File Articles of Amendment to the Articles of Organization** via ACC eCorp
   (ecorp.azcc.gov). Provide: current name (EstateMotion LLC), entity ID, the new name,
   and the member/manager signature. Fee ≈ $25 (add ~$35 for expedited). *Confirm current
   form (L-prefixed) + fee on the ACC site.*
3. **Publication: not required** in Maricopa/Pima counties. (Skip the newspaper step.)
4. After ACC approval (the amended Articles), update everything in §5.

*Verify the exact current form name and fee on ecorp.azcc.gov before filing — ACC
changes these periodically.*

---

## 4. IRS name-change notice — letter template

A single-member LLC reports a name change to the IRS by letter (the EIN is unchanged).
Send to the IRS office where you file your return. Fill the brackets, print, sign, mail.

```
[Date]

Internal Revenue Service
[IRS address for your filing location — see irs.gov "Where to File"]

Re: LLC name change — notification
EIN: [your EIN]
Old legal name: EstateMotion LLC
New legal name: Vistalia LLC
Responsible party: Troy Massey

To Whom It May Concern:

This letter is to notify the IRS that the above single-member limited liability
company has changed its legal name from "EstateMotion LLC" to "Vistalia LLC,"
effective [effective date]. The entity's EIN ([your EIN]), ownership, structure,
and address are unchanged; this is a name change only. No new EIN is requested.

Please update your records accordingly. A copy of the Arizona Articles of
Amendment evidencing the name change is enclosed.

Sincerely,

_______________________________
Troy Massey, Sole Member
Vistalia LLC
[business address]
[phone] · [email]
```

Notes: enclose a copy of the ACC-approved Articles of Amendment. If/when the LLC files
its own return, also check the "name change" box on that return. (Disregarded SMLLC income
is reported on your Schedule C — the letter is the clean way to sync the EIN record.)

---

## 5. Update-everything checklist (after the name is approved)
- [ ] Domain: point `<newname>.ai` to the app; redirect estatemotion.ai → new (keep the
      old domain a while for any inbound).
- [ ] Stripe: business legal name → "Vistalia LLC" (EIN unchanged); statement descriptor → NewName.
- [ ] Business bank account: name change with the bank (bring the amended Articles).
- [ ] Google Workspace / email: new domain + addresses; keep old mailbox forwarding.
- [ ] Supabase / Vercel / Render: project names + the site's brand strings, logo, OG image.
- [ ] Social handles claimed (§1).
- [ ] Trademark: file the application on the new name with your attorney.
- [ ] Codebase: brand strings, logo mark, titles/meta, the SEO pages — search/replace
      "EstateMotion" once the name is locked (I can do this in one pass).
```
