# ADR 0010: Shared links are frozen snapshots

## Status

Accepted.

## Context

People share a good answer with a colleague. A link that renders the live conversation
leaks everything said after it was shared, including messages the owner never meant to
publish. The system this was ported from served shared conversations live and put storage
keys of attachments into the public page, so anyone with the link could read the files
directly and any later message appeared to every viewer. Sequential or time-based ids
make links guessable.

## Decision

- `POST /api/shares` freezes the branch on screen into `shares.snapshot` (jsonb): per
  message the role, text, sources, model name, the ids of images to show and the names of
  other attachments ([`services/share.service.ts`](../../../apps/api/src/services/share.service.ts)).
  Only `COMPLETE` answers are kept; a branch without an answer is `400 SHARE_EMPTY`.
- Later messages never appear; deleting the conversation does not change the link
  (`conversation_id` is set null), revoking does.
- Attachments other than images appear by name only, never their contents or storage
  keys. Image ids are also stored in `shares.file_ids`.
- Images are served by `GET /api/shared/:id/images/:fileId`, a 302 to a short-lived
  signed URL, only for ids frozen into that share and only while the share is live
  ([`routes/shared.routes.ts`](../../../apps/api/src/routes/shared.routes.ts)).
- Link ids are 128 random bits, base64url (22 characters), not ULIDs; anything not matching
  the pattern is a 404 without a query.
- A share is dead (404 `SHARE_NOT_FOUND`) when revoked, expired (`expiresInDays`), when its
  owner is banned or erased, or when sharing is switched off in settings. Banning a user
  revokes their links.
- Admins see every live link and can take one down with a reason (audited); they see the
  title and owner, not the conversation. Public reads are rate limited per IP.

## Consequences

Positive:

- What the owner saw when they clicked Share is exactly what viewers see, forever or until
  revoked.
- No storage key or document text ever reaches a public page.
- Links cannot be enumerated or guessed.

Trade-offs:

- A snapshot duplicates text; a long conversation shared many times is stored many times.
- Fixing a typo means sharing again (a new link).
- Images still depend on the stored file: if the owner's account is erased, the share
  dies with it.

## Alternatives considered

- **Live links to the conversation.** The leak this decision removes.
- **Public signed URLs embedded in the snapshot.** They expire, or if long-lived they
  outlive revocation; the share-scoped redirect checks liveness on every view.
- **ULID share ids.** Carry a timestamp and only 80 bits of randomness.
