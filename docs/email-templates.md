# Email Templates and Tracking Reference

Status: draft for review. The standard email is a short, courteous issue report. Notice and legal wording is **not** part of it. That wording is held on a separate review sheet (`review-sheet-notice-wording.md`) for others to comment on.

## 1. Purpose

Residents report an issue to the management company from their own email app. The email carries a reference code and a tracking mailbox, so replies and the resident's own copies can be matched to the right case. The platform is a private tracking tool for community residents. Its name does not appear in any email.

## 2. Template 1: Issue report (standard email)

Merge fields are in `{braces}`. Square-bracket items are choices the resident makes in the app.

```
To: {management_support_email}
Cc: {tracking_mailbox}
Subject: {community_name} – {category} – {location_short} – {date} – Ref {ref}

Dear {management_entity_short} Support,

I am reporting the following issue in {building_or_area}:

- Reference: {ref}
- Location: [floor, corridor, unit, facility]
- Category: [cleaning / maintenance / safety / amenity]
- Description: [what is wrong, how long it has been the case]
- Urgency: [urgent – safety or water damage / standard]
- Photos: attached ({photo_count})
- First noticed: [date]

Please acknowledge with a ticket number and an expected resolution date.

This report is being tracked. Please quote the reference above in any reply so it can be matched to this report.

Regards,
{resident_name}
{unit}, {community_name}
```

### What changed from the supplied wording
| Change | Reason |
|---|---|
| Notice and legal paragraphs removed from the email | Moved to the review sheet for others to comment on |
| "Formal notice" removed from the subject | The email is a plain issue report |
| Reference line and reference in the subject | Lets replies and forwards be matched to the case |
| Tracking mailbox on Cc | The original email reaches the tracker at the moment it is sent |
| One sentence saying the report is being tracked | Plain and transparent. It does not name the tool. |
| Community, management entity and location are fields | The product is generic and each community has its own profile |

### Sending notes
- The Cc address is visible to the management company. Give it a neutral name (for example `{community_code}@{domain}`) that does not name the tool.
- An email link can pre-fill recipients, Cc, subject and body, but cannot attach files. In the native apps the email composer can attach the redacted photos. In the web fallback the resident attaches them by hand, or the app offers a download. **Decision needed.**
- Residents send the email themselves from their own email app, so it carries their own address and timestamp.

### Optional lines (off by default)
| Line | When useful |
|---|---|
| `Previously reported: {previous ticket numbers or dates}` | Repeat issues |
| `It would also be helpful if your reply could note the cause, the action taken, and any steps to help prevent it recurring.` | Where the resident wants more detail than a ticket number |
| `Other residents have also reported this issue: {count}` | Management has no way to add up reports, so a count may help prioritisation. Count only, no names. **Decision needed.** |

## 3. Template 2: Follow-up after a ticket is closed without details

For use after a closure message that does not say what the cause was, what was done, or how recurrence will be avoided. It matches the "dispute closure" action in the spec.

```
To: {management_support_email}
Cc: {tracking_mailbox}
Subject: Follow-up – {community_name} – {category} – {location_short} – Ref {ref} – Management ticket {management_ticket_no}

Dear {management_entity_short} Support,

Thank you for your message of {closure_date} confirming that ticket {management_ticket_no} is now closed.

For my records, could you please let me know:
1. the cause of the issue,
2. the work or action carried out, and
3. any steps planned to help prevent it recurring.

If the issue is still present, please treat this message as a request to reopen the ticket. Original report: {original_report_date}, Ref {ref}.

This report is being tracked. Please quote the reference above in any reply.

Regards,
{resident_name}
{unit}, {community_name}
```

## 4. Duplicate reports

- **Each resident's report is its own case** with its own reference and its own email to the management company, even when several residents report the same issue.
- The platform can link these cases together in the background. The management company has no way to add up complaints, so the number of separate reports is useful evidence of how many residents are affected, at least initially.
- Linked cases are visible only to signed-in community members and the committee.
- The management company only ever sees each resident's own email.

## 5. Tracking reference

### Format
`{community_code}-{YYMM}-{sequence}-{check}`

Example: `MRW-2610-0042-K` (community code MRW, October 2026, report number 42, check character K).

| Part | Meaning |
|---|---|
| Community code | 3 to 4 letters set in the community profile |
| YYMM | Year and month the report was created |
| Sequence | Per-community counter, zero-padded |
| Check | One character from the Luhn mod 36 method. It catches single-character typing errors and most swapped neighbours. |

The check character for `MRW26100042` is **K**, calculated and verified with a short script. The platform recomputes it to confirm a quoted reference was typed correctly.

### Rules
- The reference is a **filing aid, not a password**. It is guessable by design, so it never grants access.
- Emails are accepted only from verified sources (section 6), and any new content is held in the resident's private "Inbox to review" until the resident confirms it.
- If two references appear in one message, the message is held for the resident to assign.
- Management ticket numbers (for example "Ticket No. 00867684") are stored separately and used for matching as well.

## 6. How emails reach the case

| Route | How it works |
|---|---|
| **Cc on the original (default)** | The tracking mailbox receives the resident's original email as it is sent. It is matched to the case by the reference and takes its time from the email's own date and time. |
| **Resident forwards a reply** | If the management company replies only to the resident (their ticket emails come from a no-reply address), the resident forwards the reply to the tracking mailbox, preferably as an attached `.eml` file. The platform matches it by reference, management ticket number, message headers, or embedded text from the original. |
| **Reply-all from the management company** | If they reply to everyone, the reply reaches the mailbox directly. It is accepted only from the management company's configured sender domains and only when it matches an existing case. |

Matching order: (1) reference with a valid check character, (2) management ticket number, (3) message headers (Message-ID, In-Reply-To, References), (4) quoted text from the original, which is only proposed to the resident to confirm.

### Dates and times come from the email
Times shown on the case timeline use the **email's own timestamps** wherever possible, not the time the tracker received it. In order of preference:
1. the date header of the original message (from an attached `.eml` or the Cc copy);
2. the date and time in the forwarded-message header block in the body, with its time zone where shown;
3. the date header of the forward itself, labelled "date forwarded";
4. a date entered by the resident, labelled "entered by resident";
5. the time the tracker received it, labelled "date received", as a last resort.

The time the tracker received the message is always kept separately and cannot be changed. Each time shows where it came from. A sender controls an email's date header, so it is a record of what the email says, not proof. Full rules are in the spec.

## 7. Notes for counsel (before release)

1. The standard email contains no legal statements. Check that "This report is being tracked" is accurate and not misleading, and that the Cc to a tracking mailbox raises no data protection issue for the management company's staff.
2. All notice and legal wording is on the review sheet. None of it has been verified against the official text.
3. Approve the guidance text for the description field (facts only, neutral, first person).

## 8. Open decisions

1. Cc on the original by default, with forwarding as the fallback (current direction)?
2. Photos in the web fallback: attach by hand, or download first?
3. Include the "other residents have also reported" count line?
4. Mailbox naming: one per community, and who sets the code?
5. Which optional lines, if any, are on by default?
