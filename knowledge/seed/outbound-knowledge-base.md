---

## 0. THE PHYSICS YOU ARE WRITING INTO

- The buyer never *reads* email. They triage it standing up, on a phone, in ~4 seconds:
  sender name → subject → first line (preview text). Everything below the preview does not
  exist until the thumb decides.
- 6–10 people buy a high-ticket IT deal. The person you write to must be able to *repeat*
  your point to a colleague. Copy is written to travel.
- The market is finite (often 300–400 winnable accounts). Burning an account by irritating
  its CTO is not a rounding error. Volume math does not apply; quality math does.
- Nobody replies because they fit your ICP. The business reason must make sense **from their
  side**.
- Realistic outcome of a well-run program: 50 accounts → ~8 replies → 3 positive →
  2 meetings in two weeks. Touch one plants; touches two and three harvest.

**The one question that gates every message: "Why this person, at this company, now?"**
No answer → no message. That is a targeting problem, not a writing problem, and no template
fixes it.

---

## 1. INPUTS REQUIRED BEFORE A WORD IS WRITTEN

Copy is *assembled from a research note*, never from inspiration. If a draft is taking
45 minutes, the note is broken — go fix the note.

### 1.1 The research note (5 sections, mandatory)

```
ACCOUNT: <name> — <industry, size> · Tier <1/2/3> · researched <date>, <n> min

FACTS         — only what you observed and could link to. Checkable. Dated.
ASSUMPTIONS   — inferences, written as inferences.
UNKNOWNS      — 2–3 things public data cannot answer that would change your approach.
                (These become your discovery questions and often your first-message question.)
ANGLE         — 1–2 sentences: the business reason to contact this account NOW, and who owns it.
FIRST LINE    — the actual opening sentence, drafted while context is hot.
```

Research depth by tier: 3 min (Tier 3), 15 min (Tier 2 / most Tier 1), 40 min (Tier 1
committee plays). Stop when the marginal fact stops changing the message. Source order:
website → careers page → LinkedIn company + people → funding DB → news → reviews (G2) →
engineering blog / GitHub / changelog.

### 1.2 The signal ladder (fact → angle without lying)

| Rung | Definition | Example |
|---|---|---|
| **Fact** | Verifiable, linkable. They would nod. | "Medexa announced a $28M Series B on July 7." |
| **Inference** | What any reasonable person concludes. | "A raise that size comes with board-committed targets." |
| **Hypothesis** | Your guess at what hurts. Might be wrong. | "The two HIPAA roles take longest to fill; compliance work is blocked." |
| **Angle** | What you write: fact stated plainly + hypothesis offered as a question. | see §2 |

**Cardinal sin: rung-skipping** — stating your hypothesis as their reality.
- ✗ "Since you raised $28M, you must be struggling to hire fast enough."
- ✓ "Teams we work with usually find compliance-experienced roles take twice as long to fill — is that matching your experience?"

People forgive a wrong guess offered as a guess. They delete a wrong guess dressed as insight.

### 1.3 Signal quality

**Strong signals and what they mean:**
- **Job ads** — the loudest signal; a public confession that work exists which the current
  team cannot do. Read the *details*: 12 openings at 180 people = capacity story; 1 CTO
  opening = nothing decides for 4 months; first-ever SRE/DevOps hire = reliability pain;
  "Head of Platform" after years of feature roles = the monolith finally got funded;
  "HIPAA experience required" = compliance-critical, audit-exposed work; reposted after
  60 days / "immediate start" / above-market salary = the seat is hard to fill and the pain
  is compounding.
- **Funding** — the raise is not the angle; the *gap it creates* is. Month 0 = theater (you'd
  be message #51). Months 1–3 = planning. Months 3–6 = reality bites: promised velocity,
  eight of twenty hires made. That gap is what you write to.
- **Leadership change** — new CTO audits everything in the first 100 days, no loyalty to a
  predecessor's vendors. Write in weeks 2–8, lead with curiosity, not a pitch.
- **Tech-stack change** (migration named in an ad = multi-quarter project, understaffed).
- **Product launch** — signal is 1–3 months *after* the confetti (scaling pain, support load).
- **Incident/outage** — wait 3–4 weeks, speak to the aftermath, never make them relive it.
- **Regulation** (DORA, HIPAA, PSD2, SOC 2) — the only signal that *ages better*, right up
  to the deadline. Gold for domain-proof sellers.
- **M&A** — freeze first, thaw the quarter after; 12–18 months of integration work.
- **Layoffs** — wait 1–2 months. Not a growth story: same roadmap, fewer hands; flexible
  capacity may beat headcount in the CFO's model; for SaaS, tool-consolidation season.

**Shelf lives:** funding ~6 months · leadership change ~100 days · job ads while live +
a few weeks · incidents 1–2 quarters · regulation until the deadline.

**Signals that aren't:** work anniversaries and LinkedIn badges (an algorithm's greeting
card); expired signals (14-month-old round = trivia); irrelevant events (a new Denver
office, unless you sell Denver); overclaimed signals; **single-signal ceiling** — one signal
is an angle, two or three pointing the same way is a case. Stacked signals justify promoting
the account a tier.

### 1.4 The offer (what your copy is allowed to promise)

Formula: **vertical × problem × proof** — multiplied, so a zero in any factor zeroes the offer.

- **Vertical**: narrowed until the buyer sees themselves. "Fintech" is barely a vertical;
  "European lending and payments companies facing PSD2 and DORA deadlines" is one.
- **Problem**: the situation in *their* words. Not "digital transformation" — "you promised
  the board a roadmap and can hire two of the twelve engineers it needs."
- **Proof**: concrete. Hierarchy — named client + number > anonymized client with specific
  artifact + number + timeframe > pattern claim from experience > honest capability
  statement. Not proof: "proven," "world-class," years on market, team size, logo walls.

**The repeat test:** could the buyer repeat this to a colleague, roughly accurately, without
you? Vague offers die in the first retelling.
- ✗ "full-cycle software development partner delivering innovative solutions" → repeats as
  "some outsourcing company."
- ✓ "we give funded healthtech companies engineering teams who have already built
  HIPAA-regulated products — a first pair in three weeks, a full team inside six, so the
  roadmap doesn't wait six months for hiring" → repeats as "HIPAA-experienced engineers,
  running in three weeks."

Every number must be true and sourceable. If nine weeks was eleven, write eleven.

**Entry offer** — shrink the first yes. The ask in late-sequence touches and replies should
point at a small, priced, genuinely-useful-on-its-own step: a 2-week technical/architecture
assessment (fixed fee, report they keep), a discovery sprint, a pilot pair (8 weeks), a
compliance-readiness audit; for SaaS, a 30-day pilot on one team's live data or a benchmark
run on their own last two quarters. Rules: valuable even if nothing follows, priced (not
free), and naturally connected to the main engagement.

---

## 2. THE COLD EMAIL (TOUCH ONE)

### 2.1 Surface (what survives triage)

- **Sender**: a human name at a credible domain. Never "Sales Team", never no-reply.
- **Subject**: 2–5 specific words a colleague could have written. Lowercase or careless case,
  no punctuation acrobatics, honest.
  - ✓ `your three backend roles` · `fleetify release cadence` · `monolith question` · `the hipaa hires`
  - ✗ `Accelerate Fleetify's Engineering Velocity` (campaign) · `Quick question` (colleague-shaped
    but empty; buyers know the trick) · `Marta from Softwell — Intro` · `re: our call` when there
    was no call (gets the tap, then a reader who feels tricked) · anything with 🚀, %, caps, or
    that could headline a webinar.
  - Test: could this be a Slack message from their own head of engineering? Then it's close.
- **First line = the real subject line.** It renders as grey preview text and has exactly one
  job: prove immediately that this email was written for this person on purpose. It carries
  the trigger.
  - Banned openers (each spends the most valuable real estate saying *this is a cold email,
    delete me*): "I hope this email finds you well", "My name is X and I represent...",
    "I know you're busy so I'll keep this brief", "I came across your profile", "I've been
    following your journey", "Sorry for the cold outreach", any congratulation, any compliment,
    any narration of your research process ("I was browsing your careers page and noticed...").
  - ✓ "Fleetify is hiring three senior backend engineers, and two of the postings mention
    decomposing the monolith."

### 2.2 The four-sentence architecture

| # | Job | Rule |
|---|---|---|
| 1 | **Reason-for-you-now** | The trigger. If it could open an email to fifty other companies, you have a segment, not a trigger. |
| 2 | **Problem hypothesis** | Bridge from their fact to a cost they recognize. Specific enough to be *wrong*. Use "usually / often / from the outside", never "you are". |
| 3 | **Credibility, one sentence, with a number** | One proof point that maps to the hypothesis. A precise anonymous result beats a vague famous one. The urge to add a second proof point is the urge that produces 200-word emails. |
| 4 | **One low-friction ask** | One question, answerable from a phone in ten seconds. |

This mirrors the buyer's own triage questions in order: why me? — do you understand my
world? — why you? — what do you want?

### 2.3 Length and format

- **Under ~90 words** for touch one. Not because they can't read 200, but because at 200
  words from a stranger they *choose not to start*.
- **No bullets. No bold.** No images, no buttons, no banner signature, no attachments.
  Signature = name, role/company, one line. Short paragraphs (1–3 phone lines) with white
  space.
- **No links in touch one** (including tracked links — they route through the sequencer's
  shared redirect domain whose reputation you share with its worst customer). Offer the
  artifact instead and let the "yes, send it" be a reply. Links, decks and Looms are free
  once a thread exists (from ~touch 3 / after a reply).
- The ask must be visible without scrolling on a phone. If you have to scroll to reach it,
  cut until you don't.

### 2.4 The ask

Default to the **interest-based ask**, not a meeting:
- "Worth sending the two-page write-up of how they sequenced it?"
- "Is release cadence something you're actively working on, or further down the list?"
- "Is compliance-experienced hiring actually the bottleneck, or am I guessing wrong?"

A cold 30-minute request forces the buyer to price half an hour against six lines of context;
the honest answer is no, and "no" ends the thread. Direct meeting asks win only where friction
is low or intent is high: a referral, an inbound-ish signal, a reply deeper in a sequence, or
a genuinely time-boxed event.

**One ask per email.** "Thoughts? Also happy to jump on a call, or I can send our deck?" has
three asks and gets zero answers — choosing is work, and work is what triage deletes.

### 2.5 Worked examples

**✗ The 200-word agency pitch** (subject: "Trusted Software Development Partner — Web, Mobile,
AI/ML, Blockchain | 200+ Projects Delivered"): "Dear Marcus, Hope this email finds you well!
My name is Viktor and I represent NexGen, a leading full-cycle software development company
with 250+ certified engineers…" — every sentence answers "who are we?", none answers "why you,
why now?" The only account-specific word is the merged company name. Could go to 50,000 CTOs
unchanged, and probably did.

**✗ The fake-personal**: praise for a podcast episode, then the word **"Anyway,"** — the tell
of every fake-personal email ever sent: it marks the exact seam where personalization ends and
the template begins. Removal test: delete the first paragraph and the business logic is
unchanged → the personalization was decoration.

**✗ The feature dump**: five bullets of product capabilities + "31% faster on average" + a
calendar link. Features answer "what is it?", which is the buyer's *third* question.

**✗ The decent-but-generic** (the most instructive failure, because nothing about it is
embarrassing): "Many CTOs at growing SaaS companies tell us their engineering teams spend more
time maintaining legacy code than shipping new features. At Softwell we help software companies
modernize their platforms… Would you be open to a brief call?" Short, polite, has a problem, a
capability, an ask — and the honest answer to "which company is this email about?" is
"any company." It wouldn't offend anyone. It would just evaporate. **"Fine" is invisible.**

**✓ What to send instead** (78 words):

> **Subject: your three backend roles**
>
> Marcus — Fleetify is hiring three senior backend engineers, and two of the postings
> specifically mention decomposing the monolith.
>
> When the monolith makes it into the job ads, releases have usually slowed to the point
> where it's costing roadmap, not just patience — and hiring alone rarely speeds them back up.
>
> We ran exactly this migration for a logistics platform about Fleetify's size: releases went
> from every three weeks to twice a week in two quarters, without pausing feature work.
>
> Worth sending the two-page write-up of how they sequenced it?
>
> Marta Kovalenko
> Softwell — engineering teams for fintech & logistics platforms

Reply, two days later, six words: *"Sure, send it. Curious how sequenced."* Six words is a
landslide.

---

## 3. SEQUENCES: FIVE EMAILS, FIVE REASONS

A sequence is **not one email with four echoes**. It is five different emails that happen to
be about the same account — each must be able to start the relationship by itself, because
plenty of people read touch three first, with zero context.

### 3.1 The angle ladder

| Touch | Angle | Job | Ask |
|---|---|---|---|
| 1 | **Problem** | Observation → hypothesis → proof → question | Interest question |
| 2 | **Proof** | Make the proof pictureable: who, what changed, in what timeframe (numbers: "60 engineers, a 40-minute pipeline, freezes gone by week eight") | "Want the before/after? No call needed." |
| 3 | **Different stakeholder** | Same problem from another chair (CTO → what the CEO publicly promised). Carries a **routing question**: "if this actually sits with your platform lead, point me at them." | Route or opinion |
| 4 | **Useful artifact** | Stop describing value, hand some over: one-pager, teardown, before/after, short Loom. Include an honest limitation ("the two things that went wrong in month one"). | **First meeting ask belongs here** |
| 5 | **Honest close** | Restate the whole case in four sentences, ask for nothing, invite correction | None |

Asks escalate with evidence: question → "want the number?" → routing option → meeting →
nothing. A sequence that asks for 30 minutes in every touch is a slot machine.

Routing questions get answered by people who ignore pitches, because forwarding a problem is
easier than owning one.

### 3.2 Calendar and threading

- **Spacing**: 3–4 business days between early touches, stretching toward a week later;
  whole sequence ~3 weeks. (Day-1-2-4-6-8 cadences are written for $99 subscriptions sold into
  a market of two million; at $400k with 400 winnable accounts it reads as exactly what it is.)
  Slow spacing also lets the world hand you new material.
- **Threading**: stay in the thread while extending the same argument (a thread showing three
  substantive unanswered emails quietly argues that you are serious). **One deliberate break**
  per sequence, at the artifact touch, with a fresh specific subject line. Five separate
  threads is not a strategy; it's confetti.
- **Shape by deal**: touch count and spacing are *outputs* of deal size, committee size and
  market size. SaaS at $40–80k: 4 touches over 12 days, drop the different-stakeholder touch
  (there is no second stakeholder worth an email until a trial starts).

### 3.3 Never in a follow-up

"Just bumping this" (announces in three words that you have nothing new) · "Did you see my
email?" (invites a second rejection, in writing) · "This is my third attempt to reach you"
(converts persistence into a grievance) · "Since I haven't heard back, I'll assume improving
release velocity isn't a priority" (a stranger diagnosing their engineering strategy from
their silence) · fake-mistake subjects ("re: our conversation") · manufactured urgency ("two
slots left this week" — for what?).

All fail the same test: **they give the reader no new reason to reply.**

**Rent test before any follow-up:** if the prospect had never received message one, would
this message still be worth reading?

### 3.4 The breakup (touch 5)

Outperforms the middle touches for three plain reasons: it restates the entire case in one
compact place (many buyers triage bottom-up, so touch five is their touch one); it is the
first email that asks for nothing; and it **invites correction** — which almost nobody abuses
and a surprising number take up honestly ("You're not wrong, but it's a Q1 problem, not Q4"),
which is worth more than most booked meetings.

> Marcus — I'll close the loop here rather than become a recurring event in your inbox.
> I reached out because the changelog slowdown plus the senior backend hires looked like a
> monolith tax, and removing that tax without stopping the roadmap is specifically what we
> get hired to do.
>
> If it's not a live priority, no reply needed — I'll check back if something changes on your
> side. And if I've simply read the situation wrong and release speed is fine, tell me so in
> four words and I'll leave Fleetify alone entirely.

It must never punish, keep score, or diagnose priorities from silence. The breakup is also
the message they scroll past on the way back to you months later — write it so the thread
reopens itself.

### 3.5 When nobody replies (the common case)

Do not delete the account, do not re-run the sequence louder. Rotate to nurture with a note:

```
<Account> — sequence complete <date>. No reply, any touch. Opens t1/t4 (directional only).
FACTS: <still-true facts>
ASSUMPTION: <why, marked as assumption>
NURTURE: signal watch on <careers page / changelog / funding / leadership / their posts>
RE-ENTRY: any trigger above, or <date — e.g. first week of December, budget season>.
          Next touch must open with a NEW fact — do not re-run this sequence.
```

Re-entry, months later, writes itself: *"Marcus — saw the platform role go up. Last month I'd
have guessed you were solving the release slowdown in-house; that posting suggests it's now
funded. Worth a short conversation this time?"*

---

## 4. PERSONALIZATION AT SCALE

### 4.1 Three honest levels (pick openly, execute cleanly)

| Level | For | Unit of work | Cost |
|---|---|---|---|
| **Artisanal** | Tier 1 (~12 accounts) | One account, one research note, an email that could not be sent to anyone else on Earth | 20–40 min |
| **Segment-level** | Tier 2 (~90) | One email written to a *situation* 30 companies share, 2–3 verified specifics swapped per row | ~3 min/company after the build |
| **Template-with-honesty** | Tier 3 | A clean, specific, well-targeted email that does not fake intimacy: *"We work with logistics SaaS companies on exactly one problem: release cycles that slowed as the monolith grew. If that's not Fleetify's world, delete this with my blessing."* | minutes |

The cringe lives in the gap between levels — a Tier 3 volume play dressed as artisanal.
"I was so impressed by your journey" sent to 400 people is not personalization, it is lying
at scale. The spectrum is not about how much you fake; it is about how much you **verify**.

### 4.2 Segment-first writing (the Tier 2 method)

Relevance lives at the **segment** level, not the field level. Order of operations — and most
reps get it backwards:

1. Define the segment as a **situation with a clock**, one sentence: *"Series A/B healthtech,
   80–250 people, currently hiring HIPAA/compliance-heavy engineering roles."* (Not a
   category — "healthtech companies" can only produce category sentences like "the healthcare
   space is evolving rapidly.") If you can't write one paragraph that is specifically true for
   every company in the segment, the segment is too wide. Split it.
2. Write the **best email of your life about that situation, once.**
3. *Then* find the companies it is true for. Cut every row that doesn't fully match (expect to
   cut ~25%; if nothing fails your cut, you are rationalizing, not cutting).
4. Verify one specific per row against the **live source**, in your own words, same week as
   the send.

**Blank test:** remove every merge field. Would every reader in the segment still nod? If the
email collapses without its variables, the variables were doing work the copy should do.
**Put the intelligence in the copy; keep the variables dumb.**

Example (81 words, reads artisanal, true for 30 companies):

> **Subject: the hipaa hires**
>
> Hi {first_name} — saw {company} is {signal_fact}. Teams at your stage usually hit the same
> wall: the roadmap needs engineers who've actually built under HIPAA, and the market produces
> about four of them a year. Meanwhile every month those seats stay empty, the compliance
> milestone slides.
>
> We put a dedicated team with prior HIPAA delivery into a 150-person healthtech last year —
> seats filled in three weeks instead of five months, audit passed first try.
>
> Is the hiring on track, or is the timeline already feeling it?

Best reply received: *"Honestly it's like you've been in our sprint planning."* He was one of
thirty. There was nothing to know — every word was true.

### 4.3 Merge fields: safe, gloved, radioactive

- **Safe** (cosmetic failure only): `{first_name}`, `{company}`. Still need hygiene — human
  casing (Medika, not MEDIKA SOFTWARE SOLUTIONS LLC; not JENNIFER, not jennifer), and a
  fallback that **blocks the send** on an empty field rather than shipping a skeleton.
- **Handle with gloves** (each asserts a fact that ages): `{signal_fact}`, `{role_count}`,
  `{tech_stack}`. Verified by a human against the live source, same week as the send. Not at
  list-build time. Data does not expire on your schedule.
- **Radioactive**: `{personalized_line}` written by anything other than a person who checked
  the source. Structurally wrong: a merge field promises the same slot works for every row; a
  personal observation must be different *and correct* for every row. Automating it means
  making 30 factual claims and reading none of them.

Max three fields; zero radioactive. For every field, write down its failure mode and who
catches it. If the answer to "who catches it" is "nobody," you have found your future
screenshot.

### 4.4 The merge-disaster hall of shame

- **Naked variable**: "Hi {{FirstName}}, quick question about {{Company}}…" — converts your
  email into a confession that you were never going to read it.
- **"Congrats on the funding"** to a company that announced a 15% layoff nine days earlier.
  The data was true *once*, and nobody re-verified.
- **AI-written personal line**: "Loved your recent post about embracing failure — so
  inspiring!" The post announced the startup shutting down. An unreviewed AI line is an intern
  with no shame and infinite confidence signing your name 200 times.
- **Shouting legal entity**: nobody calls their own company by its LLC name.
- **Mismatched rows** (the deadliest and quietest): a sort applied to one column, every first
  name offset by one. The template was perfect; only a row-level check catches it.

None of these are writing failures. All are **verification** failures.

### 4.5 QC ritual before any batch (three moves, in order)

1. **Send-to-self**, fully merged with row 1, read **on a phone**: subject rendering, preview
   line, signature (watch for the tool bolting on a promo banner). Catches template-level
   problems.
2. **10-row spot check** (or a third of the batch, whichever is larger): open the merged
   preview and read each email top to bottom. Expect ~20% dirty rows even on a carefully built
   list — that is the base rate of merged data meeting the real world. **Pack rule:** one
   dirty row → find the shared cause → check every row it touches. Any row with a stale or
   dead signal leaves the batch entirely (back to nurture, not "probably fine").
3. **Read-aloud** with real data merged. Merge-speak has a sound: "I noticed that your company,
   Vantia Health, is currently hiring" is a sentence no human has ever spoken. If your mouth
   stumbles, the copy changes.

### 4.6 The P.S.

When one row offers a genuinely personal hook, don't rebuild the email — put it in a P.S.:
*"P.S. Your talk on consent-data architecture at HLTH was the best 20 minutes of my week —
the audit-log bit especially."* The body carries segment relevance, the P.S. carries the human
moment, neither is faked. **Never merge-field a P.S.** — a templated afterthought is a
contradiction the reader can feel.

---

## 5. LINKEDIN VARIANTS

Same skeleton, different envelope. LinkedIn = context-rich first contact; email = detail;
phone = speed.

### 5.1 Invite

Note or blank is arithmetic, not theology (acceptance rate = inventory). **Rule: write a note
when the best note you can write is specific to this person; send blank when it would be
generic.** A blank invite from a credible profile is neutral; "Would love to connect and
explore synergies" is a confession. Never put the pitch in the note "to save time" — that
converts a 40% acceptance rate into 15%.

- ✓ (300 chars, no ask): "Priya — I work with engineering leaders at healthtech scale-ups
  (Softwell). Following Medexa since the Series B news; the HIPAA-experienced roles you're
  hiring for caught my eye. Thought it made sense to connect."

### 5.2 First message after acceptance

Timing: between one hour and two business days. Not eleven seconds (smells like automation,
because it is), not three weeks. Length: **40–90 words, one phone screen, no scrolling.**

Four moves: **reason → problem idea (with a humility valve) → proof in picture-words → easy
question.**

> "Priya — noticed two of Medexa's twelve open engineering roles specifically ask for HIPAA
> experience. Those tend to be the slowest to fill; we've watched healthtech teams wait 4–5
> months while roadmap items queue up behind them. If I'm reading it right, part of the
> post-Series B plan depends on exactly those hires. We staffed a HIPAA-experienced pod of
> four for another healthtech while they hired at their own pace — happy to share how they
> split the work. Is compliance-experienced hiring actually the bottleneck, or am I guessing
> wrong?"

Why it works: "two of the twelve" is a *noticed ratio* — it cannot be templated (cost: 90
seconds of research). "If I'm reading it right" / "or am I guessing wrong?" are humility
valves, so the message wins on both branches — confirmation or correction. The proof is a
picture (a pod of four) and reframes the offer from "outsource instead of hiring" to "ship
while you hire." Reply that evening: *"Partly right — it's not the hiring speed, it's that our
audit-logging rework can't start until at least one of them lands."* Not a meeting; better — a
real problem in the buyer's own words.

**Services vs SaaS:** services messages sell a conversation about the buyer's *build* (proof
must be domain-shaped; category proof like "350+ projects" screams generalist, which is exactly
the fear). SaaS messages sell a conversation about the buyer's *workflow* (proof can sit nearer
the product, and a process question with pre-loaded answers gets answered: "Where does the
forecast get assembled today — CRM, sheets, or a bit of both?"). Both sell the conversation.
Neither sells the thing.

**The no-ask debate, settled:** every first message ends with a question the prospect can
answer in one line, from a phone, without opening a calendar — **and it must be a question you
actually want the answer to.** A message with no question hands the prospect the job of
inventing a reason to reply, and busy people decline unpaid work. A calendar ask comes two or
three messages later.

**Voice notes**: only after acceptance, under 60 seconds, beats scripted not sentences, same
one-word-answerable question at the end. Video only when there is something to *show*. Never a
car.

**InMail**: default is invite-then-message; the InMail badge reads as *advertisement*. Reach
for it only when the invite sat unaccepted 2–3 weeks on a decaying Tier 1 signal, when the
person visibly doesn't accept strangers, or on an Open Profile. Subject line does the triage
work: "The two HIPAA roles on Medexa's careers page", never "Quick question".

### 5.3 The follow-up ladder (3+1 over ~3 weeks)

LinkedIn runs **slower than email** — a DM thread feels like a text message; three messages in
a week into a silent chat reads the way three unanswered texts read. Leave **4–6 business
days** between message touches.

- Day 1 — first message (real signal)
- Day 6–8 — new angle or proof point, same thread
- Day 12–15 — **engagement touch** (a substantive public comment on their post, not a DM).
  The most LinkedIn-specific move: the same person showing up in a public, zero-obligation
  space, and proof no automation is involved.
- Day 20–24 — the artifact
- Day 28–32 (only if silence) — honest close, then nurture

Every touch pays rent in one of four currencies: **new angle · proof point · useful artifact ·
honest close-the-loop.** Generosity escalates as the sequence progresses — the prospect who
ignored two messages needs a *stronger* reason on the third, not a weaker one. Tier 2 gets 2+1,
Tier 3 gets 1+1. **Nobody gets touch seven** — if four escalating touches over three weeks
produced nothing, the problem is timing or targeting, and message five fixes neither.

**Ghost signs — react silently, never mention them:**
- **Profile view** → good news (your message cleared the first bar). Correct response: nothing.
  Never "Thanks for stopping by my profile!"
- **Like with no reply** → a chosen signal of awareness and a content clue (lead the next touch
  with the angle they engaged). Never "Saw you liked my comment — how about that call?"
- **"Seen" with no reply** → after one touch, meaningless; after three or four, real
  information: end on schedule with a clean close. Never "I noticed you've seen my messages."

**Real comment anatomy** (what an engagement touch looks like) — add an example, a question or
a counterpoint, from your side of the market, zero pitch:

> "Seeing the same pattern from the vendor side. One question that separates them fast: ask
> what they deliberately *don't* log. People who've genuinely shipped under HIPAA get very
> specific about exclusions and retention; people who've only read about it talk about what
> they capture. Curious whether that matches your fourteen."

### 5.4 Re-engagement after a silent close

90 days is the floor (unless a trigger fires sooner) — long enough that the message is clearly
a new thought, not touch six wearing a coat. Write **into the old thread** with a new fact on
top:

> "Jonas, you crossed my radar again — saw Priya's post about the audit-logging rework shipping
> this quarter, congrats. Back in September the bottleneck looked like the two HIPAA hires; I
> noticed one of those roles was reposted in December. Did you solve the bridge internally, or
> is that question worth revisiting now that the rework is live?"

---

## 6. WRITING THE REPLIES

**Classify before you type. The type dictates the move.** Warm replies get answered the same
business day, inside the prospect's working hours — a warm reply is a perishable good.

### 6.1 The nine email reply types

| Type | Move | Never |
|---|---|---|
| **Interested** | Answer just enough, ask **one** qualifying question, propose the call **with a reason** and two slots in their time zone | Three paragraphs; a calendar link as the first response |
| **Question** | Answer honestly and concretely, prove specificity, hand the mic back with one question. If it's beyond you: "That one's beyond me — I'll get you the real answer from our head of engineering by Thursday rather than improvise." | Marketing; bluffing; a modest paragraph that fails to answer |
| **Objection** | Acknowledge, ask one clarifying question, leave the door intact (see §7) | Winning the argument |
| **Referral / redirect** | Ask permission to use the name ("Mind if I mention you sent me his way?"), use it in line one of the next email, and **close the loop later with the redirector** | Skipping the permission step, or letting the referrer go dark |
| **"Not now"** | Pin the **event**, not the quarter; sharpen the angle; create the dated task before closing the tab | A "not now" with no dated re-entry (that's a "no" you lied to yourself about) |
| **Hostile** | **Wait 20 minutes.** Then three sentences: removal stated as *done*, honest answer about the data source, brief apology. No defense, no "actually", no "sorry you feel that way" | Arguing that your targeting was good |
| **Unsubscribe / "remove me"** | Suppress the same hour, in every tool, forever + one line: "Done — apologies for the interruption." | "Before you go…", asking why, or a queued follow-up landing two days later |
| **OOO** | **Mine it**: return date, delegate names, verified email format, sometimes a live buying signal ("for anything related to the sequencer migration, contact James Ito"). Pause the sequence; resume 2–3 days *after* the return date; log names and facts. | Pitching the delegates cold "because the auto-reply gave me your address" |
| **Wrong-person bounce** | Two doors: (1) the **successor** — inheriting a function means auditing it, the best cold window there is; (2) the **mover** — a contact who has seen your emails, at a new company, in a new-leader window | Deleting it as a data chore |

Verbatim patterns worth copying:

*Interested* → "…and honest answer: 'how we work' depends on which problem is loudest. Some
teams want senior hands inside their current release process; others want a team that takes
one slice of the monolith and owns carving it out. Which is closer to what you're weighing?
Either way, this is easier live than in six more emails. 25 minutes, and I'll bring one of our
architects so you get engineering answers instead of sales translations. Tuesday 16:00 or
Thursday 15:30 your time (Central)? Or name a slot and I'll make it work."

*Skeptical question* ("Half the agencies that email me claim HIPAA experience. What does that
actually mean in your case?") → "Fair challenge — that phrase does a lot of unpaid labor in
agency emails. Concretely for us: two current teams build patient-facing systems for US
healthtech, everyone on them works under BAAs, and the senior engineers have shipped audit
logging, role-based access and PHI-handling patterns enough times that your compliance lead
wouldn't be teaching from zero. The client names are under NDA, but I can walk you through one
build with the identifying parts filed off. Out of curiosity, what prompted the question — is
a PHI-touching build on the roadmap now, or are you vetting options for later?"

*Incumbent objection* → "Three years is a real relationship, and one cold email shouldn't
compete with it. One question before I leave you alone: is the partner covering everything on
next year's roadmap, or are there pieces — the payments-data work your job posts hint at —
where you'd want domain depth alongside them rather than instead of them? If it's all covered,
genuinely glad to hear it, and I'll close the file."

*"Not now"* → "Understood — audits eat quarters. I'll come back the first week of December
unless you tell me otherwise. So December-me shows up useful rather than generic: is the
post-audit plan more about growing the team, or about the platform rebuild your careers page
hints at? Either answer changes what I'd bring."

*Hostile* → "Done — you're removed from everything on our side as of this email, and you won't
hear from me again. To answer the question: your address came from a business-contact database,
and the miss on relevance is mine. Sorry for the noise."

*Successor after a bounce* → "Anna — I'd been writing to Piotr about the release-speed work
before learning he'd moved on, so first: congrats on picking up the platform. In my experience,
inheriting a roadmap means auditing a roadmap, and if the delivery-capacity question is anywhere
on that list, I'm happy to share the two-page assessment outline I'd sent him. If it isn't, no
hard feelings — and good luck with the first hundred days."

*Thread revival at 60–90 days* (reply **into** the old thread so history sits below) → "Replying
here so the context is below rather than re-explained. Two things changed since March: you
shipped the dispatch rewrite, and there are three new SRE roles on your careers page — which
usually means the release-speed question got bigger, not smaller. If so, worth 15 minutes now?
If it resolved itself, tell me and I'll close the file for good."

### 6.2 The six LinkedIn reply types

**Positive** → one qualifying question *before* the calendar, then name the reason for the
call. **Curious** ("how does this actually work? we've been burned before") → answer briefly,
diagnose the scar ("a body shop that threw juniors at you, or a team that built exactly what
you asked for even when it was wrong — which one was it?"), then offer the entry offer with a
technical peer on the call. **"Send info"** → ask who it's for and what stage, then send a
2-pager built for the person they'll forward it to, not for them. **Redirect** → permission +
loop-close. **Soft no** → extract the timing signal ("is it not a priority because the work is
still in planning, or because external partners are off the table generally? Asking so I know
whether to check back when the program moves, or not at all"), park with a date. **Hard no** →
one sentence, graceful, immediate exit: "Will do — sorry for the miss, and good luck with the
launch." Then actually stop.

### 6.3 The calendar ask

Three things make it land: (1) the call has a **stated reason that came out of the
conversation**; (2) it removes friction — specific length ("25 minutes", not "a quick chat"),
two concrete slots **already converted into their time zone** ("Wednesday 17:30 your time
(Boston)"); (3) propose slots first, offer the link only as a fallback convenience — leading
with a link converts "I'm interested" into "here, do my scheduling admin". Send the invite
within the hour with a one-line agenda in the description, so the forwarded invite makes sense
to whoever they drag in.

**Leave the channel when:** documents enter (→ email, which also gets you a verified address);
there's an agreed reason to talk (→ calendar); speed beats polish and they're replying within
minutes (→ phone: "this might be faster as a five-minute call — can I ring you now or after
lunch?"). The signal you're on the wrong channel is **effort asymmetry** — paragraphs out,
single lines back, or scheduling taking more messages than the conversation.

---

## 7. OBJECTIONS IN WRITING

An objection is not a wall — it is usually the first honest information the prospect has ever
given you. Silence is the real rejection.

### 7.1 The iceberg

| Surface words | Most common real concern | Underlying risk |
|---|---|---|
| "We're covered / we have a vendor" | "Switching or adding is disruptive, and I don't see what's wrong with today" | Personal: my past choice questioned |
| "Send me an email / some info" | "No reason yet to spend real attention; give me a cheap way to evaluate" | Attention |
| "No budget" (pre-price) | "There's no budget *line* because this isn't a planned category" | Org: creating a line means selling it internally |
| "Call me in Q3" | "Something bigger owns this quarter" — or a polite indefinite no | Priority |
| "Never heard of you / your team is where?" | "If this vendor fails, the failure is exotic and mine" | Personal: nobody-gets-fired-for logic |
| "We got burned before" | "Prove you fail differently than the last one" | Personal: I championed the last one too |

Grammar of every objection reply: **acknowledge → clarify → bridge → ask**, and the second beat
does 80% of the work. **Clarify before you bridge. Diagnose before you prescribe.** Every
disaster (the pitch-again reply, the discount reflex, the case-study avalanche) is a rep
bridging off a guess. In writing: one-clause acknowledgment, exactly **one** clarifying
question (two questions = zero answers), no irony (a cold reader supplies the least generous
tone), and a re-read asking *if I were mildly annoyed, how would this sound?*

**You can win the argument and lose the conversation.** An airtight rebuttal leaves the buyer
one cheap exit: silence. Nobody has ever been argued into a meeting — only made curious into
one. Type the rebuttal, don't send it; ask what they actually told you and answer that.

### 7.2 The incumbent wall

"We have a vendor" is the most information-rich rejection there is: the problem is real, the
budget line exists, someone already won the internal argument. You just aren't paid yet.
**Never make the buyer wrong for having an incumbent — make the incumbent's existence part of
your case.** Every wedge starts by agreeing.

One question splits the wall in three (genuinely happy ~1 in 5 · **tolerating** ~most ·
actively unhappy = a timing window):

> "That makes sense — a program that size needs a big partner at the core. Out of curiosity:
> is the setup covering everything you'd want it to, or are there pieces of the roadmap that
> keep sliding because the main program eats all the capacity?"

"Is everything covered?" invites a defensive yes. "What keeps sliding?" invites the truth.

Wedges: **second opinion** (keep your vendor, benchmark one workstream — "we got a second
opinion" makes the champion look diligent, not disloyal) · **overflow** (for in-house teams:
the work queuing behind them, never a criticism of the team) · **specialist** (be the thing
they don't have) · **benchmark** (SaaS: let their own numbers argue) · **plant the flag and
wait for the stumble** (when genuinely happy: respect it, leave a marker, leave).

### 7.3 Timing: pin the event, not the quarter

Test whether "call me in Q3" is real: *"what happens between now and then that changes this?"*
A real deferral names an event (a release ships, a migration lands, a planning pass runs).
A reflex produces fog ("things should be calmer" — nobody's Q3 is calmer). Fog earns an honest
close and a signal watch.

Dates slip silently; events carry their context wherever they move:

> "I'll check back the first week of July — after carrier visibility is out and after your June
> pass, when you actually know whether a platform line exists. If the release slips, the
> check-back slips with it: the trigger is the event, not the date. Between now and then I'll
> only write if I see something genuinely worth your time — no 'just checking in', I promise.
> And if June's answer is 'still no line', that's a real answer and I'll take it. Fair?"

Staying warm across a pinned quarter: **write only when something changed, and lead with the
something.** Two touches in fourteen weeks, one of them deliberately silent ("I see your hiring
is failing" is not warmth, it's surveillance with a smile). Example of an earned touch:

> "Marcus — saw carrier visibility hit beta. One thing worth stealing from the logistics client
> I mentioned: when their visibility feature went live, webhook volume from carrier integrations
> roughly tripled in month one, and the queue nobody was watching became the incident nobody
> enjoyed. One dashboard graph on queue depth before GA saved them the 2 a.m. version of that
> discovery. Ignore if you're ahead of it. Not a sales email — July is July."

On the reopen: press play, not rewind. Do not restart discovery on a buyer who is already sold
on the problem.

### 7.4 Ghosts: the revival ladder

First, **diagnose which ghost** by rereading the thread and writing one sentence about where it
died: *warm-then-silent* (best; full ladder, ~1 in 4–5 returns within a quarter) ·
*never-replied* (no relationship existed; signal watch only — no change, no touch) ·
*went-dark-after-pricing* (the silence is about the internal case they haven't built, not your
number — **never discount into a void**; help them build the case instead).

Four rungs, each of which must contain something the buyer didn't have before:

1. **New signal** (strongest — the reason sits in their reality): "Marcus, Fleetify just posted
   three platform engineering roles — first infrastructure hires I've seen from you since we
   talked. Last spring you told me the monolith work kept losing the argument to feature
   pressure. Did it finally win, or is this something else?" No reference to the silence, no
   "as I mentioned previously."
2. **New artifact** — work you did for *their* situation, forwardable, honest about its
   assumptions ("I had to guess at these two inputs, correct me").
3. **New angle** — change what the problem costs, and concede ground ("even as a bridge while
   you hire, not a replacement for hiring").
4. **New person** — coordinate, don't repeat: a different question from a different vantage
   point, the original contact named as *context*, never as evidence against herself. The
   sentence that must never appear: "Elaine hasn't replied, so I'm contacting you."

Then the **honest close**: name the ending, restate the reason in one clause, offer honorable
exits, leave the door open, wish them well. It works because it cancels the guilt debt, asks
for nothing, and creates real (not manufactured) now-or-never.

Rhythm: revival runs on **weeks**, not days — 30–60 days of rest after the original sequence,
then 2–3 weeks between rungs, three rungs is a full climb. Then stop the *thread*, keep the
*account*: signal watch, max one signal-triggered touch per quarter.

---

## 8. CONSTRAINTS FROM DELIVERABILITY (they shape the copy)

The filter judges before the buyer does, and reputation is shared and sticky.

Copy-level rules:
- Touch one is **plain text**: no images, no attachments (an unsolicited PDF from a stranger is
  the shape of malware), no links, no tracked clicks, no HTML template, no signature banner.
- **Spintax**: light use keeps a hundred sends from being byte-identical. Greedy use (every
  sentence spinning, merge fields in odd corners) produces the statistical fingerprint of
  machine-generated text. **Automate structure, never sentences you have not read.**
- Subject lines: no money claims, no capitals, no urgency, no punctuation abuse. Conveniently,
  the subject that passes the filter and the one that passes a human's 4-second triage are the
  same line.
- One broken merge field does double duty: it tells the filter you are a campaign and the human
  that you never looked.
- Replace links with an offer: *"There's a 2-page write-up of how the rebuild went — want me to
  send it over?"* Safer **and** better, because a yes to that question is a reply, and replies
  are the one signal filters and revenue agree on.

Program-level context a writer should know: cold email never leaves the primary domain; 2–3
aged secondary domains, 2–3 real-person mailboxes each, warmed 3–6 weeks, capped at ~25–50 cold
sends/mailbox/day; every address verified (bounces under 2%, 5% is a fire alarm); one central
suppression list checked on every import; weekly seed tests to Gmail/Outlook. Opens are
directional only (never a reported result) — a *collapse* is real, a level is not.

Compliance in one paragraph: **opt-out regimes** (CAN-SPAM/US) — cold B2B email is legal,
lying in it is not: true sender, true subject, a real physical address, a working opt-out you
actually honor (law says 10 days; a professional does it the same hour). **Legitimate-interest
regimes** (GDPR-style) — four legs: the person's *role* is genuinely relevant, you used their
*work* address, objecting is *easy*, and you can *say why you contacted them* ("healthtech CTO
hiring HIPAA-experienced engineers, we sell exactly that" is an answer; "they were in a
database of 40,000 emails" is not). **Consent-first markets** (DACH in practice) — route to
LinkedIn and phone, save email for after the first conversation. Compliance is a deliverability
strategy wearing a suit: every honored unsubscribe is a spam complaint that never happened.

---

## 9. AI-SPECIFIC RULES (read this section twice)

### 9.1 The three laws

1. **AI drafts, humans verify.** Verify means: every factual claim traced to a source a human
   *opened*. Diff test — if nothing changed between draft and send, you skimmed, you didn't
   verify.
2. **Source-bound or it doesn't exist.** A fact that doesn't trace to a document a human fetched
   is a pattern the model completed. Forbidden prompt: *"What do you know about <company>?"* —
   the answer will be fluent, structured, and about half false, and you cannot tell which half
   without doing the research yourself. **The model is allowed to read; it is not allowed to
   remember.**
3. **AI never sends.** No workflow ends in a buyer receiving a message no human deliberately
   chose to send. If you cannot name the human who read *this exact message*, it didn't have one.

### 9.2 Jobs AI does well

Summarizing sources you pasted (with a tag per fact) · generating candidate **angles from
verified facts** (expect 1 usable out of 3) · classifying replies into types · cleaning up call
notes and CRM records (it will catch "budget approved" that was actually "we'd have to find
money") · objection rehearsal · translating your own proven message into a segment variant
**with every fact-shaped slot left empty and marked**:

> [FIRST_NAME], saw [COMPANY] is hiring [N] engineers including [SPECIFIC_ROLE] after the
> [ROUND]. When a fintech team grows that fast, the [COMPLIANCE_FRAMEWORK] work usually lands
> on whoever is least busy rather than whoever knows it. We've helped two payments teams take
> that off the roadmap without slowing the core team. Is that piece already owned at [COMPANY],
> or still floating?

The slots are the point. A model told to personalize will personalize, whether or not it knows
anything.

### 9.3 Jobs AI wrecks

Unsourced personalization · compliment slop · full auto-send · fake research.

Also: grounding prevents *invention*, not *blandness*. A perfectly source-bound angle can still
be wallpaper ("maintaining engineering culture as you scale" fits every funded company on
earth). Only a human smells that. And a citation is a claim, not evidence — watch for sentences
that **outrun their source** (a CTO's joke about architecture becoming "the team is struggling
with technical debt [S2]").

### 9.4 The slop detector every buyer now runs

Buyers pattern-match on **shape**, before conscious reading. Tells:

- **Symmetrical sentences**: "isn't just a challenge — it's an opportunity", "not only faster,
  but smarter", "from strategy to execution". One is suspicious, two is a verdict.
- **"I hope this finds you well" 2.0**: "I came across your profile and was genuinely
  impressed", "I've been following your journey", "your recent post really resonated".
- **Unasked compliments**: "your commitment to innovation", "your impressive track record",
  "the great work you're doing at X". Praise with no noun attached is a machine clearing its
  throat.
- **Three-adjective lists**: "robust, scalable, and future-proof", "secure, compliant, and
  reliable", "seamless, efficient, and cost-effective". **The single most reliable tell** —
  it's how a model pads a claim it has no evidence for. Humans use one adjective, or none.
- **Landscape sentences**: "in today's fast-paced environment", "in an ever-evolving healthtech
  landscape", "as the industry continues to shift". A sentence about the era instead of the
  reader.
- **Vocabulary**: leverage, streamline, unlock, empower, elevate, seamless, resonate, journey,
  mission, synergy, holistic, robust, cutting-edge, game-changing. None is banned in English;
  all of them in ninety words are a fingerprint.
- **Perfect grammar with no texture.** Real people writing fast leave a fingerprint: a
  fragment, a dash used oddly, a sentence starting with "Also". The machine's message is
  flawless the way a hotel lobby is flawless. Keep one small human imperfection —
  "from the outside that reads like" rather than "this suggests that".
- **Uniform close**: "Would you be open to a brief conversation?", "Would love to explore how
  we can help", "Happy to share more if it's of interest."

Annotated failure (8 tells in 71 words): *"Hi Marcus, I came across Fleetify [2.0 opener] and
was genuinely impressed [unasked compliment] by your commitment to innovation in the logistics
space [compliment with no noun]. In today's fast-paced environment [landscape sentence], scaling
engineering teams isn't just a challenge — it's an opportunity [symmetry]. We help companies like
yours [could be anyone] build robust, scalable, and future-proof platforms [triplet]. I'd love to
explore [vocabulary] how we could support your growth. Would you be open to a brief conversation?
[uniform close]"*

Same length, opposite effect:

> "Marcus, saw your post about releases going from weekly to roughly monthly, and that the
> service-extraction role has been open since spring. From the outside that reads like the
> monolith is now the constraint, not headcount. We've done extraction work for two logistics
> teams your size with a small team and a defined exit rather than a permanent hire. Is the slow
> release train something you're actively trying to fix this quarter, or living with for now?"

Every sentence is about Marcus's Tuesday. Two facts, each with a source someone opened. One
imperfection. A question answerable in six words.

### 9.5 Prompt skeletons

A good prompt is a checklist: **sources in, format out, inference forbidden, unknowns declared.**

**Research summary:**
```
Work ONLY from the sources pasted below. You have no other knowledge about this company;
anything not in the sources does not exist.
1. Every fact ends with its source tag, like [S2].
2. Do not infer, estimate, or generalize. If a source says "we shipped four releases last
   quarter," you may not write "release velocity is declining." Report what is written.
3. Anything a salesperson would want that the sources do not state goes under UNKNOWNS.
   Never fill a gap with a guess.
4. No adjectives, no advice, no summary paragraph.
Output: FACTS (with tags) / UNKNOWNS / QUOTES (up to 3 verbatim, with tags)
SOURCES: [S1] … [S2] … [S3] …
```

**Angles from facts:**
```
Below is a research note with FACTS and ASSUMPTIONS, labeled. Facts can carry an angle alone;
assumptions must be flagged. For each persona, produce exactly 3 angles:
- SIGNAL: the specific fact, quoted from the note (or "ASSUMPTION:" + quote)
- PROBLEM HYPOTHESIS: one sentence. Use "may" or "often," never "is."
- OPENING QUESTION: one question a first message could end with. No meeting request.
No angle may rest on anything absent from the note. No compliments, no congratulations.
If you cannot ground 3 angles, produce fewer and say what's missing.
```

**Reply draft (few-shot on YOUR voice — style adjectives converge on the average; examples
don't):**
```
Learn my voice from the 5 examples below — real messages I wrote that got replies. Match their
length, rhythm and word choices. Do not upgrade my vocabulary.
Hard constraints: max 80 words · if the prospect asked a direct question, answer it in
sentence one · no compliments, no exclamation marks, no adjectives about my company or theirs ·
at most one question, at the end · use only facts present in THREAD and CONTEXT. Invent nothing.
MY 5 MESSAGES: … THREAD: … CONTEXT: …  Produce 2 drafts.
```
Voice files are personal and non-transferable — a shared voice file means three reps sending
the same voice, which is the automation smell this whole discipline exists to avoid.

Human pass on every AI reply: read it aloud and rewrite anything you wouldn't say; verify every
number against CONTEXT; check a direct question got a direct answer, not a pivot; delete any
sentence doing rhythm instead of work ("maps the monolith and de-risks the roadmap" is a rhyme
no human produces on a Tuesday); confirm the ask matches the thread's temperature.

---

## 10. FINAL PRE-SEND CHECKLIST

Run on every touch-one email or first message:

1. "Why this person, at this company, now?" — answerable in one sentence, from a fact.
2. Sender is a human name at a credible domain.
3. Subject: 2–5 specific words a colleague could have written. Honest.
4. First line carries the trigger. No greeting nicety, no "my name is", no apology, no
   compliment, no congratulation.
5. Four sentences doing four jobs: reason-for-you-now → problem hypothesis (hedged: "usually",
   "often", "from the outside", "if I'm reading it right") → one proof with a real number → one
   easy ask.
6. ≤90 words (email) / 40–90 words (LinkedIn DM). Ask visible without scrolling on a phone.
7. Zero bullets, zero bold, zero images, zero links in touch one; signature ≤3 lines.
8. One ask, answerable from a phone in ten seconds. No cold 30-minute request.
9. **Fifty-others test**: could this exact message go to fifty other people? Name the sentence
   that pins it to this one company. If you can't, go back to the research note.
10. **Blank test** (segment sends): remove every merge field — would every reader in the segment
    still nod?
11. **Slop scan**: symmetry, 2.0 opener, unasked compliment, three-adjective list, landscape
    sentence, uniform close, banned vocabulary. One hit = rewrite. Two = delete and start over.
12. Every fact traced to a source you opened, and dated (a job posting can close between
    verification and send).
13. **Read it aloud.** Would you say this to a stranger at a conference? Would you say it to
    their face?
14. **Four-second test**: send it to your own phone, look for four seconds, lock the screen.
    What was it about? Would this buyer tap or kill it?
15. For a follow-up, additionally: the **rent test** — would this be worth reading if message
    one had never existed? — and a distinct angle no other touch in the sequence is doing.

---

## 11. THE TEN PRINCIPLES UNDERNEATH ALL OF IT

1. **Why this person, at this company, now.** Nothing goes out without an answer.
2. **Facts, assumptions, unknowns.** Label them — in notes, replies, summaries, CRM records.
3. **Every touch has a job.** A follow-up that only reminds does not go.
4. **Their math beats yours.** The impact number in the buyer's words, from the buyer's numbers.
5. **Nobody replies because they fit your ICP.** The reason must make sense from their side.
6. **What did the buyer *do*?** Actions, not sentiments, with a date on the next one.
7. **Specific beats vague, short beats long, a question beats a pitch.**
8. **Disqualifying makes quota.** "If it's all covered, I'll close the file" is a real sentence.
9. **Robots watch, humans talk.** AI drafts, humans verify, nothing auto-sends, every fact has
   a source.
10. **The system outlasts the lucky day.** One heroic message is a story; a rhythm is a career.
