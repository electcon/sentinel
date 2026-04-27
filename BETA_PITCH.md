# Sentinel — beta pitch

You forward / paste this to Jolly, Sands, Laubacher campaign managers.
Goal: 30-min Zoom this week, sign on as one of three free beta customers,
target list collected by end of next week.

## 1-paragraph version (email body)

> Hi [name],
>
> The team behind VoteROI is building a defensive social-media and threat-
> monitoring tool for Dem and Indy-aligned campaigns. It watches Reddit,
> Bluesky, news, and public Facebook for what's being said about your
> candidate, family, and staff — flags credible threats and doxxing in
> real time, gives you a daily digest of what's trending, preserves
> evidence so you can hand it to law enforcement or platforms cleanly.
>
> We're picking three campaigns for the closed beta cohort that ships
> June 15. Free during beta. You'd be one of them. 30 minutes on Zoom
> this week to walk you through it and collect your target list (people
> we should monitor on your behalf — candidate, family, key staff,
> surrogates).
>
> What time works next week?
>
> — David Wheeler
> david@voteroi.com

## Demo deck outline (5 slides for the 30-min Zoom)

**Slide 1 — Why this exists**
- Campaign social channels are firehoses. Most campaigns can't read it
  all, miss credible threats, or only find out after the fact.
- Existing tools (ZeroFox, Recorded Future, Brandwatch) are sold to
  Fortune 500s, priced for Fortune 500s, and don't speak campaign
  vernacular. Cost $5-10K+/month, designed for compliance teams not
  campaign chiefs of staff.
- Sentinel: campaign-native, $500/month after beta, real-time threat
  triage built around how campaigns actually work.

**Slide 2 — What it does in v1 (June 15)**
- Reads Reddit, Bluesky, RSS news, public Facebook Pages.
- Resolves mentions to your target list (candidate, family, staff).
- Classifies every mention against a 4-tier threat rubric (noise →
  hostile rhetoric → credible threat → imminent violence).
- Real-time email alert on tier 3+. Daily 7am ET digest.
- Evidence preserved per-mention (S3 archive + screenshot) for law-
  enforcement / platform reporting.

**Slide 3 — What's NOT in v1**
- X / Twitter ingest (firehose cost prohibitive at MVP — coming Phase 2)
- Podcast / TV transcript ingestion (Phase 2)
- Opponent monitoring / oppo research (Phase 2 — separate product surface)
- SMS or mobile alerts (email only in v1)
- Honest ceiling: this is a v1. We tell you what we miss; you tell us
  what you'd pay to add.

**Slide 4 — Liability + ethics framing**
- Sentinel is a monitoring tool, not a security service. Best-effort
  classification can miss credible threats. You retain responsibility
  for your security posture, law-enforcement coordination, and physical
  safety.
- We monitor public posts only. No private DMs, no scraping behind
  logins, no buying private data.
- Customer-side: AUP requires the tool be used for defense of the
  customer's own targets, not for opposition research or harassment of
  others. Misuse breaches the contract.

**Slide 5 — What we need from you**
- 30 min today / this week to sit with you. Walk through it. Sign the
  beta agreement (one page).
- Your target list: candidate name + aliases, family members to monitor,
  key staff, key surrogates, top 3-5 search terms unique to your race.
  We don't need passwords, login info, or anything sensitive — just
  what's already public.
- Designated alert recipient: who gets the tier-3 email at 3am? (Most
  campaigns: chief of staff + comms director; some: candidate's
  spouse depending on threat type.)
- Honest feedback weekly during beta. We want to ship the right thing.

## Beta agreement (1-page, attach to first email)

```
Sentinel beta participation — Letter agreement

Customer: [campaign name], represented by [campaign manager / chief of
staff name].
Provider: VoteROI / American Muckrakers PAC, Inc. (Sentinel is operated
by the same team that ships VoteROI.com. Sentinel is a separate product
surface, with separate data storage and access controls.)

Beta period: 2026-06-15 through 2026-09-15 (3 months) unless extended
by mutual written agreement. Cost: $0 during beta.

What Sentinel does:
  Monitors public social-media and news content for mentions of the
  customer's named targets. Classifies each mention against a 4-tier
  threat rubric. Sends real-time email alerts on tier 3+ events.
  Sends a daily digest of activity. Preserves evidence (raw payloads
  + screenshots) for the customer's later use.

What Sentinel does NOT do:
  - Provide physical security or law-enforcement services
  - Replace the customer's existing security or comms infrastructure
  - Monitor private channels (DMs, encrypted apps, login-walled posts)
  - Guarantee detection of every threat — the classifier is best-effort

Customer commitments:
  - Provide a target list (candidate, family members to monitor, key
    staff, key surrogates) at onboarding
  - Designate at least one alert recipient (24/7 reachable email)
  - Provide weekly feedback during the beta
  - Use the tool only for defensive monitoring of customer's own
    targets, not for opposition research or harassment of others
  - Treat any data received from Sentinel as confidential — not for
    public use without provider's written approval

Provider commitments:
  - Best-effort detection of credible threats per the published 4-tier
    rubric
  - Real-time alert (email) within 5 minutes of detection on tier 3+
  - Evidence preserved at S3 cold storage for at least 12 months
  - Weekly customer-success check-in during beta
  - 99% uptime target on dashboard / alerts; degraded performance
    notification within 30 min of incident detection
  - Customer's data is the customer's data; we do not share it,
    aggregate it for other customers, or use it for marketing

Liability disclaimer:
  Sentinel is a best-effort monitoring product. Provider's liability
  is limited to the cost of services rendered (i.e., $0 during beta).
  Customer agrees that Provider is not responsible for harm resulting
  from missed threats, false negatives, classification errors, or
  delays in alert delivery. Customer maintains responsibility for
  security posture, law-enforcement coordination, and physical safety.

Termination: either party may terminate with 7 days' notice. On
termination, Provider deletes customer's monitored data within 30 days
unless customer requests evidence preservation for ongoing legal /
law-enforcement matters.

Counter-signed:

  ___________________________   ___________________________
  Customer rep                   Provider rep (David Wheeler)

  Date:                          Date:
```

## Talking points for the live Zoom

(Use as a script if helpful.)

> "We saw what you've been dealing with on social — the comments under
> [recent campaign post / event]. What's your current process for
> deciding which of those is a real threat vs. just angry-internet?
> [Listen.] What we're building is an LLM-driven triage layer that
> takes that load off your team and surfaces only what's actually worth
> your attention.
>
> The thing we want to avoid most is alert fatigue. So our default is
> conservative — when in doubt, escalate to a human reviewer (us, on
> our side) before bothering you. You only get pinged on credible
> threats and imminent threats. Everything below that lands in a
> dashboard you can check at your own pace.
>
> The cost during beta is zero. The cost after is $500/month per
> campaign for the first six months. We're not asking for a long-term
> commitment — we're asking for three months and your honest feedback.
> If at the end of three months you don't think it's worth $500/month,
> you walk and we go back to the drawing board."
