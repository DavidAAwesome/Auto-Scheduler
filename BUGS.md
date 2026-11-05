# AutoPlan bug bash

Branch `lanphan/splitOptions`, 2026-11-04. Walked through in headless Chrome against this branch, with a throwaway
database and the real OpenAI model.

Not covered: real Google or Firebase sign-in (the identity calls were stubbed, so no real account was created),
Google/Outlook calendar import, image upload, and password reset email.

Priority: **P1** crash or wrong data, **P2** blocked flow, **P3** confusing text or layout.

| ID | Priority | Status | Summary |
|----|----------|--------|---------|
| B1 | P1 | Fixed (49e0be5) | Asking for a break fails with a 500 |
| B2 | P1 | Fixed (199b1a6) | "Add a task" confirm saves every draft while saying it saves one |
| B3 | P1 | Fixed (c77743a) | A one-time class is read as weekly |
| B4 | P1 | Fixed (56391b1) | The request text ends up in an event's name |
| B5 | P1 | Fixed (96eb710) | AI-invented "Not before" and session limits on drafts |
| B6 | P2 | Fixed (56391b1) | "show me ways to split them" is dropped when it follows new items |
| B7 | P2 | Fixed (fe0647a) | An event the AI leaves unnamed blocks the plan |
| B8 | P2 | Fixed (4c1ad0d) | Split options from chat render below the drafts, out of sight |
| B9 | P3 | Fixed (ab530cb) | Add event is disabled with no reason when it ends before it starts |
| B10 | P3 | Fixed (ab530cb) | The event form counts breaks as work sessions |
| B11 | P3 | Fixed (4434d0a) | Chat shows raw dates such as 2026-11-05 |
| B12 | P3 | Fixed (e2bdd68) | "Greedy heuristic" jargon in chat and in the preview |
| B13 | P3 | Fixed (f14c00c) | The sidebar's "No available hours · set hours" wraps badly |
| B14 | P3 | Fixed (ba63f89) | Any message is taken as a draft answer while a question is open |
| B15 | P3 | Open | On a phone, the chat sheet covers split options and the calendar |
| B16 | P3 | Fixed (85f8148) | Replaced sessions are listed one by one as "Moves" in a split preview |
| B17 | P1 | Fixed (7fdee1c) | The AI can return one item twice, and both copies are saved |
| B18 | P1 | Fixed (8fd7053) | Saved breaks stay on the calendar after their work is gone |
| B19 | P1 | Fixed (40dfc68) | An activity with a stated day and times becomes a flexible event |
| B20 | P3 | Open | "Class Mon/Wed 10-11:15am until Dec 18" gets a garbled name and one date |
| B21 | P2 | Fixed (bbd26a5) | A draft that cannot fit before its deadline shows no warning |
| B22 | P2 | Fixed (db458a2) | A filled-in name is still asked for, and short tasks are offered splits |
| B23 | P1 | Fixed | Weekdays resolve to the wrong date |

Open: B15 and B20.

Behavior to expect, not bugs:
- AM/PM is still asked for "10-11:30". The app does not guess AM or PM, so the demo message gets one question; answering "AM" sets both times and the split options follow.
- "Study for calculus 4h due Thu noon" cannot fully fit: with 9 AM to 5 PM hours and a 50-minute focus limit, only 2h 30m fits before noon on the day it is due, so the preview reports the rest and offers "Apply partial plan". On the day itself, less fits.

## Details

### B1. Asking for a break fails with a 500 (P1)
1. Have any saved schedule, at a time that is not a multiple of 5 minutes (for example 11:54 PM).
2. In chat, say "I need a 15-minute break now".

Expected: a break preview. Actual: `POST /schedule/break` returns 500, and chat says "The scheduler produced an invalid
schedule (window): "Break" is outside the planning window." The break starts at the current minute, but the window
start is rounded up to the next 5-minute mark. It only works on an exact 5-minute mark, which is what the tests used.

### B2. "Add a task" confirm saves every draft while saying it saves one (P1)
1. Send a message that creates several drafts, and leave them under review.
2. Say "Add a task: Quiz prep, 90 minutes, due Friday at noon".
3. Chat says "Confirm to save it as a task". Press **Confirm tasks**.

Expected: the prompt says what will be saved. Actual: all four drafts are saved, including a fixed event.

### B3. A one-time class is read as weekly (P1)
1. Say "class Tue 10-11:30" as part of a plan message (the AI does this on most runs).

Expected: one event next Tuesday. Actual: a weekly event with no dates, which blocks the plan until first and last dates
are given. Nothing in the message says it repeats.

### B4. The request text ends up in an event's name (P1)
1. With no AI key, send the demo message ending in ", show me ways to split them".

Expected: an event called "Class". Actual: the event is called "Class , show me ways to split them", and it is saved
with that name.

### B5. AI-invented "Not before" and session limits on drafts (P1)
1. Send the demo message with AI on, and open the review panel.

Expected: fields the user did not state stay empty. Actual: drafts carry a date-only `earliestStart` of today, which
the "Not before" field cannot show (browser warning: value "2026-11-04" does not conform to the required format), and
a longest session equal to the whole task (240 for a 4-hour task).

### B6. "show me ways to split them" is dropped when it follows new items (P2)
1. Send "Study for calculus 4h due Thu noon high priority; lab report 3h due Sat; class Tue 10-11:30, show me ways to
   split them".

Expected: the items are read, then split options appear once they are ready. Actual: the items are read and the
request is ignored, with no options and no mention of it.

### B7. An event the AI leaves unnamed blocks the plan (P2)
1. Send the demo message. On some runs the class comes back with no title.

Expected: an event called "Class". Actual: "Untitled", with questions about "this item" and the question "What should
this item be called?"

### B8. Split options from chat render below the drafts, out of sight (P2)
1. Have drafts under review, then say "show me different ways to split them".

Expected: the options are visible. Actual: chat says "Pick one above the calendar", but the options sit below the
drafts in a small scroll area, so nothing visibly changes.

### B9. Add event is disabled with no reason when it ends before it starts (P3)
1. Add Event, From 10:00 AM, Until 8:00 AM.

Expected: a message. Actual: the button is greyed out with no explanation.

### B10. The event form counts breaks as work sessions (P3)
1. Edit an event so it covers one work session and one break.

Expected: "1 planned work session overlaps". Actual: "2 planned work sessions overlap", while the calendar says 1.

### B11. Chat shows raw dates (P3)
1. Send any plan message. Actual: "due 2026-11-05 12 PM". Expected: "due Thu, Nov 5, 2026, 12 PM".

### B12. "Greedy heuristic" jargon (P3)
1. Get a preview with unplaced work, then read chat or "why didn't it fit?". Actual: "AutoPlan places work with a
   deterministic greedy heuristic. Unallocated minutes mean this heuristic found no valid place..."

### B13. "No available hours · set hours" wraps badly (P3)
1. As a new user with no availability, look at Today's Tasks. Actual: the dot and the link wrap onto separate lines.

### B14. Any message is taken as a draft answer while a question is open (P3)
1. Leave a draft with an open question and say "hello". Actual: "That didn't answer ...". The question stays open, and
   ordinary chat is blocked until it is answered, though recognised commands and messages ending in "?" still work.

### B15. On a phone, the chat sheet covers split options and the calendar (P3)
1. At 390 px wide, ask for split options in chat. Actual: the options and calendar are behind the sheet until it is closed.

### B16. Replaced sessions are listed one by one as "Moves" (P3)
1. Compare splits for a task that already has saved sessions. Actual: one "Moves ... Replaced by this split option."
   line for every session, which pushes the useful text down.

### B17. The AI can return one item twice (P1)
Found while retesting B6.
1. Send the demo message. On one run the AI returned "Lab report" twice.

Expected: one "Lab report". Actual: "I read 4 items", with both copies under review and both would be saved, doubling the
work. Items that match on kind, name, length and dates are now merged.

### B18. Saved breaks stay on the calendar after their work is gone (P1)
Reported after the bug bash.
1. Apply a schedule, then complete or delete all its tasks.

Expected: no breaks. Actual: "Break" blocks stayed (Thu to Sat at 9:50, 10:50, 11:50, 12:50). Cleanup ran only for
`DELETE /tasks/{id}`, not for completing a task, deleting a session or deleting through chat. Automatic breaks are no
longer saved, older ones are removed on load, and chat "delete breaks" now works with confirmation.

### B19. An activity with a stated day and times becomes a flexible event (P1)
Reported after the bug bash.
1. In chat, say "Gym every Monday and Wednesday 9–5".

Expected: a weekly fixed event on those days. Actual: a flexible event of 480 minutes that asks "By when should Gym
happen?" and then says "Repeating flexible work is not supported". Without AI, the bare "9–5" was not read as a time at
all. With a draft question open, the message could also be taken as the answer to it.

### B20. Weekdays without "every" get a garbled name (P3)
1. With no AI key, say "Class Mon/Wed 10-11:15am until Dec 18".

Expected: a weekly class. Actual: a one-time event on the next Monday called "Class /Wed until Dec 18".

### B21. A draft that cannot fit before its deadline shows no warning (P2)
Reported after the bug bash.
1. In chat, say "Study 3 hours due in 30 minutes".

Expected: a warning with options on the draft. Actual: a normal draft, with nothing said until "Can this fit?" was
pressed. Without AI, "due in 30 minutes" also ended up in the task's name, with no deadline. Sessions were never placed
after the deadline; tests now hold that in place.

### B22. A filled-in name is still asked for, and short tasks are offered splits (P2)
Reported after the bug bash.
1. In chat, say "Read chapter, 10 minutes, due Friday. Show ways to split it".

Expected: no question about the name, and "This task is too short to split, so it'll be one 10-minute session."
Actual: the name field said "Read chapter" while the draft asked "The name of "Read chapter" could not be read" and
listed "Still needed: name". Review trusted the reader's flags over the field's value. The AI only flags this on some
runs. Notes in parentheses could also reach the item.

### B23. Weekdays resolve to the wrong date (P1)
Reported after the bug bash, on Thu Nov 5.
1. Say "Essay due Wednesday": it became Wed Nov 4, already past.
2. Say "team meeting Monday 10-11 AM": it became Sat Nov 7.

Expected: the next such weekday, with today only if the time hasn't passed. The AI's date was trusted, and the built-in
parser took a bare weekday as today even after its time had gone. Past dates were also hidden by the compact panel. The
AI could return an empty copy of an item, or mark `location` unreadable on a task, which stopped the draft.
