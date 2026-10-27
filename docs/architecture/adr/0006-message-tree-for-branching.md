# ADR 0006: Messages form a tree

## Status

Accepted.

## Context

People regenerate answers they do not like, try another model on the same question, and
edit a question they asked badly. If those actions overwrite or delete messages, the
earlier answer is gone and an edited question silently changes the history the later
messages were based on. A flat list with "delete everything after" loses work; keeping
copies of whole conversations wastes space and breaks links.

## Decision

- `messages.parent_id` points at the message a message answers or follows; a question's
  parent is an answer (or null for the first question), an answer's parent is its
  question ([`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql)).
- `conversations.current_leaf_id` marks the branch on screen. The branch is the path from
  the root to that leaf, read with one recursive query (`chatRepo.pathTo`,
  [`repositories/chat.repository.ts`](../../../apps/api/src/repositories/chat.repository.ts)).
- Regenerate is a new answer under the same question: a sibling of the old answer
  (`POST /api/messages/:id/regenerate`).
- Edit is a new question under the earlier parent: a send with `parentId`
  (`POST /api/chats/:id/messages`), validated to be an answer in the same conversation
  ([`services/chat/chat.service.ts`](../../../apps/api/src/services/chat/chat.service.ts)).
- `PUT /api/chats/:id/leaf { messageId }` shows another branch: the leaf becomes the
  newest descendant of that message (`newestLeafUnder`).
- Every message DTO carries `siblingIds`, so a client draws the "2 of 3" switcher without
  a second request ([`presenters/chat.presenter.ts`](../../../apps/api/src/presenters/chat.presenter.ts)).
- The context sent to a model is the path to the question being answered; the rolling
  summary records the message it covers up to and is used only when that message is on
  the path ([chat-engine.md](../chat-engine.md)).
- Old branches are never deleted on their own; deleting the conversation removes them all
  (`ON DELETE CASCADE`).

## Consequences

Positive:

- Nothing a user wrote or was shown is lost by regenerating or editing.
- Each branch is a consistent history: a model never sees an answer to a question that
  was later edited away.
- Shares freeze exactly the branch on screen ([ADR 0010](0010-frozen-share-snapshots.md)).

Trade-offs:

- Reads walk the tree with recursive CTEs instead of a simple ordered select.
- Storage grows with every regenerate.
- The conversation list's full-text search matches messages on any branch, including ones
  not on screen.

## Alternatives considered

- **A flat list with truncation on edit.** Simple, but destroys answers people may want
  back.
- **Copying the conversation on every edit (forks).** Multiplies conversations in the
  sidebar and duplicates attachments.
- **Versions on a message row.** Handles regenerate, but not the different follow-ups
  that hang off each version.
