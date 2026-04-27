# Sentinel — engineering hire pack

You forward / paste these. I can't post to your Slack channels or
hiring forums; you do that part. Templates below.

## Job spec (1-page, send to candidates)

```
─────────────────────────────────────────────────────────────────────────
Backend / full-stack engineer — contract, 7 weeks, $80–90/hr, ~25 hr/wk

We're building a defensive social-media + threat-monitoring platform
for Democratic and Indy-aligned campaigns at every level. Codename
Sentinel; public name TBD. Same team that ships VoteROI.com.

Three real campaigns sign as betas at launch (June 15, 2026). You'd
be employee 1 on the engineering side, working directly with the
founder.

What you'd build (week-by-week scope is documented; happy to share):
  - Reddit / Bluesky / RSS / public-Facebook ingest workers
    (Node 20, Postgres, S3 evidence preservation)
  - LLM threat classifier integration (Claude API, structured-output
    prompt-eng — taxonomy already drafted)
  - Per-customer dashboard (mention volume, threat queue, case
    management, daily digest email, real-time tier-3 alerts)

What we're looking for:
  - 3–5 yrs backend, fluent in Node + Postgres + AWS basics. Bonus
    for prior data-pipeline / ingest work.
  - Comfortable with LLM API integration (no in-house ML).
  - Politically aligned with Dem causes — we're not asking for proof,
    but it filters self-selecting candidates.
  - Available May 1 start, contract 1099 or via your own LLC.

Comp: $80–90/hr depending on experience, ~25 hrs/wk × 7 weeks = $14–16K.
Real possibility of converting to a full-time founding role with
equity if Phase 2 budget materializes (driven by beta customer
traction post-launch).

Stack: Node 20, Postgres on Render, AWS S3, Claude API. Same shape as
VoteROI infra. No K8s, no microservices, no premature complexity.

Reply with: GitHub or portfolio, one paragraph on the most relevant
data-pipeline you've shipped, and a sentence on why this product
interests you.

— David Wheeler, founder, VoteROI / Sentinel
  david@voteroi.com
─────────────────────────────────────────────────────────────────────────
```

## Slack post (Higher Ground Labs / Tech for Campaigns alumni — 250 chars)

```
Building defensive monitoring tool for Dem campaigns. Need contract
backend eng, ~25hr/wk × 7wks, $80-90/hr, May 1 start. Node + Postgres
+ Claude API. Three friendly betas at launch. DM for SoW. — David W
(VoteROI)
```

## YC "Who Wants to Be Hired" reply template (post-1st-of-month)

YC's standard format is "Reply to this comment if YOU want a job."
We post on the "Who's Hiring" thread instead, on the 1st of May.
Format:

```
Sentinel | Backend Engineer | Remote / US time zones | Contract |
$80-90/hr | ~25hr/wk × 7 weeks

Building defensive social-media + threat monitoring for Dem and
Indy-aligned political campaigns. Codename product, same founder
as VoteROI.com. Three friendly campaign betas launch June 15.

Stack: Node 20 + Postgres + AWS S3 + Claude API. No K8s, no
microservices. You'd be eng #1, working directly with the founder.

Looking for someone who's shipped a real data pipeline before, is
fluent with LLM API integration (no in-house ML), and is politically
aligned. Phase 2 conversion to full-time founding eng + equity is
likely if beta traction is real.

Email david@voteroi.com with: GitHub/portfolio, one paragraph on a
data pipeline you've shipped, and why this product matters to you.
```

## Personal-referral DM template (paste, customize per recipient)

```
Hey [name] — building a side product that needs an engineer for
~7 weeks contract. Defensive social monitoring for Dem campaigns
(threats / harassment / doxxing detection). $80-90/hr, ~25hr/wk,
May 1 start. Node + Postgres + Claude API stack.

You know anyone — including you — who'd be a fit? Three real
campaigns signed as betas. Phase 2 conversion to founding eng with
equity is likely.

Spec doc: [I'll link the public-facing version once posted]
— David
```

## Where to post / send (priority order)

1. **Higher Ground Labs alumni Slack** — I'm told you have access via
   the VoteROI work. Post in #jobs or #hiring (whatever the convention
   is there).
2. **Tech for Campaigns alumni network** — same shape.
3. **Code for America alumni Slack** — civic-tech adjacent, mission-aligned.
4. **DemLabs / Bluebonnet Data alumni** — narrower but very high signal.
5. **Personal referrals** — DM 5-10 engineers from your network this
   week. Even if they decline, they may refer one person.
6. **YC "Who Wants to Be Hired" / "Who's Hiring" — May 1 thread.**
7. **Backup: Toptal, Gun.io, Contra** — paid, vetted, faster but more expensive.

## Screening questions (when candidates reply)

Three short-answer questions, gates the LLM-and-data-pipeline test:

1. Briefly describe a backend ingest pipeline you've shipped to
   production. What were the throughput / reliability tradeoffs?
2. Have you integrated an LLM API (Claude/OpenAI/etc.) into a
   production service? What was the prompt-versioning strategy?
3. This product monitors people's online activity for credible
   threats against political candidates. What's one ethical concern
   you'd want addressed before shipping it?

Question 3 filters self-selecting fits. We want someone who has thought
about it and has a substantive answer, not "no concerns" or "let me
think about that."

## Interview loop (1 round, 60 min)

After screening:

- 15 min: founder context (you describe Sentinel + VoteROI) + Q&A
- 30 min: design discussion — "given the rubric in THREAT_TAXONOMY.md
  and the schema in ARCHITECTURE.md, walk me through how you'd
  implement the Reddit ingest worker so that (a) it's idempotent
  on retry, (b) the LLM call cost stays bounded, (c) tier-3+ alerts
  fire within 5 minutes of post-time."
- 15 min: rate, schedule, references, paperwork

No coding test. Their portfolio + their answer to the design
question is enough at this scale.

## Decision criteria

Hire if:
- Has shipped at least one Node + Postgres production service
- LLM-API integration is hands-on, not theoretical
- Question-3 answer shows real thinking on the dual-use ethics
- Available May 1, can commit ~25 hr/wk reliably for 7 weeks
- Communication on email/DMs has been within 24 hrs

Pass if:
- Wants to lead architecture vs. execute against a spec (we have
  the spec)
- Wants to use this as a learning project for a stack they don't
  know yet (we need ship-mode)
- Can't articulate one ethical concern about the product
- Pushes hard on rate / schedule before showing fit
