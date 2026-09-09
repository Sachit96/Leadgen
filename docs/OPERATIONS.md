# Operating On Radar

A short guide to running the system day to day, and to the decisions it makes on
your behalf.

## The daily rhythm

**Today** is the command center. It is ordered by what needs a person:

1. **Waiting on a human** — conversations the AI escalated. Deal with these
   first; they are the ones where a real reply changes the outcome.
2. **Hot conversations** — prospects showing buying intent.
3. **Today's calls** — appointments in the next few hours.
4. **Tasks due** — anything you or the system flagged.
5. **Sending queue** — pending, in-flight, and anything dead-lettered.

## What the AI decides on its own

- Whether a reply is positive, negative, a question, or an opt-out.
- What to ask next, from the qualification field list.
- When a prospect is engaged enough to propose a time.
- When it is out of its depth.

## What it always escalates

Deterministically, before any model call:

- A request to speak to a person.
- Being asked whether it is a bot.
- Legal language.
- Contract, invoice, refund or billing questions.
- Price *negotiation* (it will quote the price from Settings; discounts are
  yours to decide).
- Complaints or accusations.
- Someone ready to buy immediately.
- Anyone asking who is contacting them.

And from the model's own output:

- Confidence below your threshold (Settings → AI).
- Anything it cannot answer from the offer and knowledge base.
- Hitting the turn limit without booking.

## What it will never do

- State a price, guarantee or contract term that is not in Settings. A blank
  guarantee field means it is instructed never to imply one.
- Assert anything not in the prospect's verified research. Unknown fields are
  named explicitly in its prompt so there is nothing to fabricate from.
- Send a message with an unresolved `{{variable}}`. That prospect is paused and
  flagged instead.
- Claim to be a person.
- Message anyone on the do-not-contact list.

## Guardrails you control

Settings → Sending:

| Control | Effect |
|---|---|
| Daily cap (org) | Ceiling across every campaign |
| Quiet hours | Nothing automated sends outside them, in the prospect's local time |
| Sending days | Which weekdays automation runs |
| Contact cooldown | Minimum gap between two automated messages to one person |
| Max automated per contact per day | Hard per-person ceiling |
| Opt-out footer | Appended to the first message of each sequence |

Per campaign: its own sending window, weekdays, daily capacity and minimum
score.

All of these are re-checked **at send time**, not just when a message is
queued — a job that waited overnight is held to the rules as they are now.

Human replies are not subject to the automated window. If you are typing at
9pm, that is your call to make.

## Reading the analytics honestly

- **Reply rate** is over prospects contacted, not messages sent.
- **Delivery rate** is over messages actually sent — a message that never
  arrived cannot earn a reply.
- **Booking rate** is over qualified conversations, not over everyone.
- **Variants stay "too early" until 30 sends.** Do not scale an arm before
  then. A 60% reply rate from five messages is noise, and acting on it is how a
  genuinely good angle gets killed.
- **Revenue per 100 prospects** is the number that decides whether a list is
  worth working.

## When something goes wrong

**Messages are not sending.** Check the worker is running (`npm run worker`, or
your Cron hitting `/api/worker/tick`). Then Settings → Queue: pending jobs mean
the worker is idle; deferred jobs name their reason in the last error.

**A message dead-lettered.** Settings → Queue shows the provider error and a
retry button. Codes like `21211` mean the number itself is bad — the system has
already suppressed it.

**The AI stopped replying.** Check the AI page for the failure rate and recent
runs. A failed turn flags its conversation and notifies you; the conversation is
still fully answerable by hand. Nothing is lost.

**A prospect got a message they should not have.** Their conversation timeline
shows every event with a timestamp and whether a human or the system caused it.
`activities` is append-only, so the record cannot have been edited after the
fact.

## Adding a new niche

Roofing is the default campaign template, not a hard-coded assumption:

1. Settings → Scoring: adjust the high-ticket industry list and weights.
2. Create a campaign with the new industry.
3. Write step-one variants for the new audience.
4. AI → Knowledge: describe the offer as it applies to them.
5. AI → Objections: add the objections that niche actually raises.
6. Adjust the qualification fields if the discovery questions differ.

Nothing in the codebase needs to change.
