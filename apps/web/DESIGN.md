# Design language

The web app follows one calm design language. It should feel like a quiet, well-made tool
for thinking and writing, never like a template: a cool grey ground, type doing the work,
the answer at the centre, a single teal accent. These rules are the contract for every page.

## Foundations

| Token | Use |
| --- | --- |
| `font-display` (Bricolage Grotesque, 600 to 700, tracking -0.02em) | Page titles, the empty-chat greeting, section headings in settings and admin |
| `font-sans` (Hanken Grotesk) | Everything else. Answers 15.5px at line height 1.7, meta 13px, labels 12.5px |
| `ink` | Text and the one solid call to action per screen (the send button, `Button variant="primary"`) |
| `primary` / `brand` | Links, citation marks, focus rings, the active underline, small accents. Never large fills |
| `background` / `ground-2` | Page ground; the sidebar and the user's message bubble sit on `ground-2` |
| `card` + `shadow-card` + `rounded-card` | Only surfaces that float: the composer, menus, dialogs, the lightbox, generated images |
| `border` | 1px hairlines between list rows and sections |

Widths: the conversation column and the composer `max-w-[780px]`, settings `max-w-[860px]`,
admin `max-w-[1200px]`, gutters `px-4 sm:px-6`. Light and dark mode are a token swap: never
hard-code a colour (`bg-white`, `#fff`, `text-gray-*`).

## Rules

1. **No box inside a box.** A surface never contains another bordered or tinted panel.
   Lists inside a surface are rows separated by hairlines.
2. **Answers are not cards.** An assistant message is plain prose on the page ground with
   its actions (copy, read aloud, regenerate, branch arrows) as quiet icons below it. Only
   the user's own message gets a soft bubble, so the two voices read apart at a glance.
3. **Forms are not wrapped in cards.** A settings page is a column of sections: heading,
   one line of help, fields, a save button.
4. **Choices are words, not pills.** Tabs and filters are plain words in a row; the active
   one is ink with a 2px underline as wide as the word. Use
   `components/common/underline-tabs.tsx`.
5. **Facts are type.** "GPT-class · vision · 128k context" is one line of 13px meta text
   joined by middle dots, not chips. Tool steps ("Searched the web", "Read 3 pages") are one
   muted line each, expandable, never a coloured panel.
6. **One lit action per screen.** One `primary` button; secondary actions are `outline`,
   `ghost` or a text link. Destructive actions confirm in a dialog that names the thing.
7. **Buttons are 10px-corner bars**, never capsules. Icon-only buttons are round
   (`IconButton`) and always have a label (tooltip and `aria-label`). Hover-only actions
   stay reachable by keyboard: they fade in on `focus-visible` too.
8. **Streaming is calm.** Text appears as it arrives with no typing animation and no
   bouncing dots; the page scrolls only while the reader is already at the bottom. Stop is
   always one click away, in the place of the send button.
9. **Instant UI.** The user's message, renames, pins and deletes are optimistic; skeletons
   match the final layout; never a bare spinner on a blank page. Errors say what happened
   and what to do, with the API `code` mapped in `lib/errors.ts`, and a failed answer keeps
   the partial text with a "Try again" action.
10. **No filler.** No "Welcome back!", no icon-in-a-tinted-circle feature grids, no gradient
    blobs, no invented numbers (usage is shown only when it is real). No em dashes in any
    copy.
11. **Accessible by default.** Every interactive element is reachable and labelled; focus
    rings are visible; colour is never the only signal; contrast passes WCAG AA in both
    themes. New answer text is announced politely, not character by character.

## Patterns

- **Shell**: a left sidebar (new chat, search, projects, images, then chats grouped by
  Today, Yesterday, Previous 7 days, Previous 30 days, then months, pinned first) that collapses on desktop and
  becomes a sheet on phones; the conversation fills the rest.
- **Empty chat**: the greeting in display type, the composer centred under it, and up to
  four starter prompts as plain text rows in two columns.
- **Composer**: one floating surface with the text area, attachments as thumbnails above
  it, and a row of quiet controls: attach, tools (web search, image), dictation, the model
  picker, send or stop. Enter sends, Shift+Enter breaks a line.
- **Message**: markdown with code blocks (language label and copy), KaTeX, tables that
  scroll sideways, citation marks that open the source list, images that open the lightbox.
  Edited and regenerated turns show `< 2 / 3 >` arrows to move between branches.
- **Projects**: a header with the name and instructions, the project's files as a list of
  rows, then its chats.
- **Admin**: a left sidebar of areas, a page header with the title and the primary action,
  then tables with hairline rows, filters as underline tabs plus one search field, and
  detail in a right-side sheet.
- **Empty states**: one sentence of what this is and one action, using `EmptyState`.
- **Dates**: `lib/time.ts` helpers; relative for recent activity, absolute in the audit log.
