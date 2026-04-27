# Threat Classification Taxonomy v1

The LLM threat-tier classifier reads this rubric. Every ingested mention
that references a customer's target gets one of these four tiers. Above
**tier 2**, a human reviews before any "resolved" status. Above **tier 3**,
real-time email alert fires.

This is the bias setting: **conservative classifier**. False negatives at
tier 3+ are catastrophic (real threat missed, person hurt). False positives
are tolerable (alert fatigue is fixable). When in doubt, escalate one tier.

---

## Tier 1 — Noise

**Definition:** Critical, mocking, dismissive, or impolite content that
expresses opinion or disagreement without targeting the person's safety,
family, livelihood, or property. The 99th percentile of social-media
political speech.

**Examples:**
- "Eileen Laubacher is a terrible candidate, she'll lose by 20 points."
- "What an idiot. This is why we're losing."
- "This guy doesn't deserve to win."
- "She's a sellout, classic establishment dem."
- Repeated "L" or laugh-react emoji on the candidate's post.

**Action:** Indexed for analytics (volume / sentiment / velocity charts).
No alert. No human queue.

---

## Tier 2 — Hostile rhetoric

**Definition:** Content that crosses from criticism into hostility, but
without specific threats, doxxing, or escalation language. Includes:
- Personal insults targeting appearance, family, religion, ethnicity
- Vague wishes for harm ("I hope she gets what's coming")
- Conspiracy framing about the target ("paid agent of [X]")
- Coordinated dogpiles where 50+ accounts repeat the same insult
- Calls to "get rid of" or "destroy" the target politically — without
  language suggesting physical harm
- Sustained campaigns from a single account directed at the target

**Examples:**
- "She's a coward and her family should be ashamed."
- "Time to take this clown out of public life. Dig up everything."
- "Hope karma comes for him."
- 80 accounts under 30 days old all posting "Laubacher = liar" in 2 hours.

**Action:** Lands in the human review queue (not auto-escalated to
customer). Reviewer either dismisses, escalates to tier 3, or files
under "ongoing campaign" for trend tracking. Reviewed within 4 hours
during business hours, 24 hours overnight.

---

## Tier 3 — Credible threat or doxxing

**Definition:** Specific threats to the target, their family, or staff.
Doxxing of any kind. Direct calls for harm. Anything that a reasonable
campaign security person would want to see within 60 minutes.

**Includes:**
- Direct threats of violence ("I'm going to make her pay")
- Threats to family members or staff by name
- Threats targeting children specifically
- Posting of home address, family member's school, employer, daily
  routine (doxxing)
- Posting of staff personal info, including where staffers live or
  family details
- Posts from accounts known to have made threats before (history flag)
- Calls for in-person confrontation at home or family events
- Weapon references combined with target's location or schedule
- Sustained 1:1 harassment from an identified person (not coordinated
  inauthenticity — a real individual making it personal)

**Examples:**
- "Bet your wife and kids didn't think you'd come home to [address]."
- "I'll be at her event Saturday. Bring something for her."
- "Here's where his daughter goes to school: [school name]"
- "@laubacher you're going to regret this. I know where you live."

**Action:** Real-time email alert to customer's designated security
contact within 5 minutes. Evidence preserved (screenshot + raw API
payload + S3 archive of the surrounding context). Lands in the
customer's threat queue marked "credible — needs disposition." Suggested
actions in the alert: report to platform, document for law enforcement,
contact local PD, notify candidate's protection detail.

---

## Tier 4 — Imminent violence

**Definition:** Specific, time-bound threats with apparent capability or
location. The "this person is at risk in the next hours/days" tier.

**Includes:**
- Threats with a specific time + location ("I'll be at his rally Saturday")
- Threats combined with weapon possession or photos
- Threats that follow a known stalking / escalation pattern
- Statements indicating the person has already taken action ("I'm
  parked outside her house right now")
- Threats from accounts that have prior law-enforcement reports

**Examples:**
- "I have my [weapon] ready for Saturday's debate."
- "Just left Laubacher's office, told the staff what's coming."
- "Her car is in the driveway, blue Subaru, I see you."

**Action:** Same as tier 3 PLUS phone call placed to the customer's
emergency contact (Twilio voice, scripted message). Evidence preserved
with extra metadata. Sentinel's customer success team flags for
follow-up within 30 minutes.

---

## Implementation notes for the classifier

- Prompt the model with this taxonomy in full (system prompt). Provide
  20+ in-context examples per tier covering different surface forms
  (dog-whistles, sarcasm, coded language).
- Always return tier + confidence (0–1) + brief rationale.
- Confidence < 0.7 → bump up one tier (conservative bias).
- Threat language varies by community — Reddit's /r/conservative differs
  from /r/politics differs from Bluesky differs from Truth Social. Keep
  per-source temperature/threshold knobs.
- Re-evaluate every 4 weeks against false-positive / false-negative logs.
- Do NOT use the classifier output as the sole decision basis for any
  law-enforcement referral. Human review on tier 3+ before any external
  action.

## Liability framing for customer-facing copy

Sentinel is a monitoring tool, **not** a security service. The
threat-classification system is best-effort and may miss credible
threats or flag false ones. Customers retain responsibility for
their own security posture, including law-enforcement coordination,
physical security, and emergency response.

This statement appears in the AUP, the customer onboarding doc, and
the dashboard footer.
