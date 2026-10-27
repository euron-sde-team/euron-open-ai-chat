# Files

Attachments, project knowledge files, avatars and generated images: how bytes get into
storage without passing through the API, what is checked before a model may read them, how
documents become searchable, and who may read what. Paths are relative to the repository
root.

| Piece | File |
| --- | --- |
| Upload, complete, ownership, processing, expiry | [`apps/api/src/services/file.service.ts`](../../apps/api/src/services/file.service.ts) |
| Allowlist, extensions, size ceilings, magic bytes, storage keys | [`apps/api/src/domain/file-rules.ts`](../../apps/api/src/domain/file-rules.ts) |
| Text extraction | [`apps/api/src/integrations/extract.ts`](../../apps/api/src/integrations/extract.ts) |
| Chunking and token estimates | [`apps/api/src/domain/chunking.ts`](../../apps/api/src/domain/chunking.ts) |
| S3 and local storage | [`apps/api/src/integrations/storage.ts`](../../apps/api/src/integrations/storage.ts) |
| DTOs and signed URLs | [`apps/api/src/presenters/file.presenter.ts`](../../apps/api/src/presenters/file.presenter.ts) |
| Client side | [`packages/api-client/src/upload.ts`](../../packages/api-client/src/upload.ts) |

## 1. Purposes and kinds

| Purpose | Accepts | Used by |
| --- | --- | --- |
| `ATTACHMENT` | `IMAGE`, `PDF`, `DOCUMENT`, `SPREADSHEET`, `TEXT` | A message's `fileIds` |
| `PROJECT` | `PDF`, `DOCUMENT`, `SPREADSHEET`, `TEXT` | `POST /api/projects/:id/files` |
| `AVATAR` | `IMAGE` | `PATCH /api/users/me { avatarFileId }` |
| `GENERATED` | `IMAGE` | Made by the server only (`storeGenerated`); a client cannot create one |

| Kind | MIME types | Ceiling |
| --- | --- | --- |
| `IMAGE` | JPEG, PNG, WebP, GIF, HEIC, HEIF | 20 MB |
| `PDF` | `application/pdf` | 100 MB |
| `DOCUMENT` | DOCX | 50 MB |
| `SPREADSHEET` | XLSX, CSV | 50 MB |
| `TEXT` | `text/plain` (source code and config extensions), `text/markdown`, `application/json` | 20 MB |
| `AUDIO` | WebM, Ogg, MP3, M4A, WAV | 25 MB (dictation only, never stored as a file) |

The effective limit is the smaller of the kind ceiling and the user's tier `max_file_mb`
(25 MB in the seeded default tier) ([quotas.md](quotas.md)). SVG, HTML, XHTML, XML and
scripts are refused as declared types, and executable extensions (`exe`, `dll`, `jar`,
`dmg`, ...) are refused by name. Source files are accepted as `TEXT` and always stored and
served as `text/plain; charset=utf-8`, so a `.js` or `.html` attachment can never run from
a signed URL.

## 2. The upload flow

```
client                         API                                storage
  | POST /api/files               |                                    |
  |  { purpose, fileName,         |  checkDeclared: allowlist,         |
  |    mimeType, sizeBytes }      |  extension, size; rate limits      |
  |                               |  files row PENDING, server key     |
  | <-- UploadTicket ------------ |  presignPut(key, type, size)       |
  |  { file, uploadUrl, headers,  |                                    |
  |    expiresAt }                |                                    |
  | PUT uploadUrl (headers) ----------------------------------------> |
  | POST /api/files/:id/complete  |  HEAD: size == declared            |
  |                               |  first 4 KB: magic bytes match     |
  |                               |  PENDING -> PROCESSING             |
  |                               |  fx.job files.process (after commit)
  | <-- ChatFile PROCESSING ----- |                                    |
  | GET /api/files/:id (poll) --> |  worker: re-encode or extract      |
  | <-- ChatFile READY ---------- |  PROCESSING -> READY               |
```

1. **Declare** (`createFile`, `POST /api/files`): `checkDeclared` validates the MIME type
   against the purpose, the extension against the type, and the size against the limit
   (`413 FILE_TOO_LARGE`, `400 FILE_TYPE_NOT_ALLOWED`, `FILE_EXTENSION_MISMATCH`,
   `FILE_PURPOSE_MISMATCH`, `FILE_EMPTY`). Rate limits: 60 per 10 minutes and 200 an hour.
   The file name is cleaned; the storage key is made by the server
   (`storageKeyFor(purpose, id, ext)`).
2. **Presign.** S3: a `PutObject` URL signed over `Content-Type` and `Content-Length`, valid
   10 minutes; the client must send exactly the returned `headers`. Local storage: a
   signed, expiring capability URL on `/api/files/local/:token` (HMAC keyed from
   `REFRESH_SECRET`), carrying the content type and size.
3. **Upload** straight to storage. The API never holds the bytes.
4. **Complete** (`completeFile`, `POST /api/files/:id/complete`): `HEAD` the object; its size
   must equal the declared size (`FILE_SIZE_MISMATCH`); the first 4096 bytes must match the
   declared type's magic number (`FILE_TYPE_MISMATCH`). A mismatch marks the file
   `REJECTED` and deletes the object. Otherwise a conditional update moves it to
   `PROCESSING` and queues `files.process` after commit. Calling complete again is
   harmless.
5. **Process** (`processFile`, the worker), then `READY`.

`uploadFile` in the api-client does all of this, with progress from
`XMLHttpRequest.upload.onprogress` (browsers and React Native) and polling until `READY`
or `REJECTED` ([mobile-clients.md](../guides/mobile-clients.md)).

In the system this was ported from, clients sent storage keys and the server attached
whatever key it was given, so anyone could reference any object in the bucket. Here the
API never accepts a storage key from a client and never returns one.

## 3. Processing

### Images

- Decoded and re-encoded with sharp: auto-rotated from EXIF, then EXIF, GPS and any
  trailing data dropped; resized to at most 2048 px on the long edge (also what vision
  models want); PNG, WebP and GIF keep their format, everything else (including HEIC)
  becomes JPEG at quality 88.
- A 512 px WebP thumbnail is written next to it (`<key>.thumb.webp`).
- An image that cannot be decoded is `REJECTED`; HEIC on a server whose image library
  cannot decode it is rejected with a message to export as JPEG.
- Generated images (`storeGenerated`) are stored `READY` with a thumbnail at once.

### Documents

- Text extraction ([`integrations/extract.ts`](../../apps/api/src/integrations/extract.ts)):
  PDF with unpdf (a serverless build of pdf.js; page count kept), DOCX with mammoth (raw
  text), XLSX with exceljs (every sheet as CSV-like rows, at most 5000 rows), CSV and text
  as UTF-8. Nothing executes document content: no macros, scripts or external references.
- Cleaned (control characters, line endings, runs of blank lines), capped at 400000
  characters, and its token estimate stored.
- Cut into passages of about 1600 characters with 200 of overlap, at paragraph or sentence
  ends where possible (`chunkText`), stored in `file_chunks` with a generated `tsvector`.
- A PDF with no text (a scan) is rejected with "scanned PDFs need to be sent as images";
  an encrypted or damaged document is rejected.

## 4. How a model reads a file

| File | On the newest message | On older messages |
| --- | --- | --- |
| Image, vision model | Pixels (base64 image part) for the two most recent user messages with images | A one-line note |
| Image, non-vision model | Refused at send (`MODEL_NO_VISION`) | A one-line note |
| Document | Text inline in a `<file name="...">` block, up to 60% of the remaining context budget, cut with a note when longer | Named only; reachable through `search_project_files` |
| Project knowledge file | Not inlined | Reachable through `search_project_files` in every chat of the project |

`search_project_files` ranks passages with `ts_rank_cd` against
`websearch_to_tsquery('simple', query)`, and falls back to matching any word of three or
more letters when no term matches ([ADR 0009](adr/0009-postgres-full-text-search.md)).
Details: [chat-engine.md](chat-engine.md#22-fitting-the-context-window).

## 5. Who may read what

- **Owner only.** `ownFile` loads by id and requires `owner_id = actor.id` and a status other
  than `DELETED`; anything else is `404 FILE_NOT_FOUND`, whether the file exists or not.
  `attachableFiles` checks a whole list in one owner-scoped query before a message can
  carry it. In the system this was ported from, an attachment id from another account was
  served to anyone who asked (an IDOR).
- **Signed URLs.** A `ChatFile` DTO carries `url` and `thumbUrl` only when the file is
  `READY`; both are signed GET URLs valid `SIGNED_URL_TTL_SECONDS` (900). Non-image files
  are signed with a download disposition. The bucket is private; nothing is public.
- **Shares.** A share serves only the images frozen into its snapshot, through
  `GET /api/shared/:id/images/:fileId`, which checks the file id against `shares.file_ids`
  and redirects to a fresh signed URL ([ADR 0010](adr/0010-frozen-share-snapshots.md)).
  Other attachments appear in a share by name only.
- **Admins** have no endpoint that reads a user's file.

## 6. Lifecycle and deletion

| Event | Effect |
| --- | --- |
| `DELETE /api/files/:id` | Refused with `409 FILE_IN_USE` when the file was sent in a message (the conversation would change under the reader: delete the conversation instead). Otherwise removed from projects and avatar, marked `DELETED`, extracted text and chunks dropped |
| Conversation deleted | Its `message_files` links go; the file rows stay until unreferenced |
| Account erased | Every file of the account is marked `DELETED` |
| `maintenance.expire-files` (every 30 min) | Deletes rows and objects (and thumbnails) for: `PENDING` or `PROCESSING` older than 24 h, `REJECTED`, `DELETED`, and `READY` files older than 48 h that nothing references (no avatar, message, project, gallery image or live share). The reference check is repeated in the `DELETE` itself, so a file attached meanwhile survives |

## 7. Storage backends

| `STORAGE` | Where | Use |
| --- | --- | --- |
| `s3` | `S3_BUCKET` in `S3_REGION`; `S3_PUBLIC_ENDPOINT` for presigned URLs that a browser can reach (the emulator locally); `AWS_ENDPOINT_URL` for Floci | Every deployment; the local stack via Floci |
| `local` | `DATA_DIR` on the API container | Tests and quick trials; refused by `assertProductionConfig` |

On AWS the bucket is private, encrypted with the deployment's KMS key, with CORS for the
app origin (plus `media_cors_extra_origins`). The web app's CSP allows `MEDIA_ORIGINS` in
`img-src`, `media-src` and `connect-src` so the browser can PUT to and read from it
([`apps/web/src/middleware.ts`](../../apps/web/src/middleware.ts)).
