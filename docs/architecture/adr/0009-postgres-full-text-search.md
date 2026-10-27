# ADR 0009: Postgres full-text search instead of a vector database

## Status

Accepted.

## Context

Projects carry knowledge files and chats carry attached documents; the assistant needs to
find the passages that matter in them. The usual answer is embeddings in a vector
database. That means an embedding model and its key, a second datastore to run, back up
and secure, re-embedding when the model changes, and a place where document text is
copied again. Most deployments of this app hold a modest number of documents per user,
and users usually ask with the words that appear in the document.

## Decision

- Documents are read once by the `files.process` job (PDF, DOCX, XLSX, CSV, text,
  [`integrations/extract.ts`](../../../apps/api/src/integrations/extract.ts)), capped at
  400,000 characters and cut into passages of about 1,600 characters overlapping by 200
  ([`domain/chunking.ts`](../../../apps/api/src/domain/chunking.ts)).
- Passages live in `file_chunks` with a generated `tsvector` column
  (`to_tsvector('simple', content)`) and a GIN index
  ([`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql)).
- `search_project_files` ranks passages with `ts_rank_cd` against
  `websearch_to_tsquery('simple', query)`, limited to the files the turn may read (the
  project's knowledge files plus documents attached in the conversation, all `READY`);
  when nothing matches, it retries with any word of three or more letters
  ([`services/chat/tools.ts`](../../../apps/api/src/services/chat/tools.ts) `searchPassages`).
- The `simple` configuration (no stemming, no stop words) keeps every language working
  the same way.
- The newest message's documents are also sent inline up to 60% of the context budget, so
  short documents need no search at all ([chat-engine.md](../chat-engine.md)).
- Message text has the same kind of index (`messages.search`) for the conversation list
  search.

## Consequences

Positive:

- No extra datastore, model or key; documents are searchable seconds after upload.
- Ownership is enforced by the same query that searches (file ids are resolved per turn).
- Deleting a file deletes its chunks in the same transaction.

Trade-offs:

- Lexical matching misses paraphrases and synonyms that embeddings would find; the model
  can search again with other words, and the fallback helps near misses.
- No stemming: "running" does not match "run".
- Very large libraries rank less well than a tuned semantic index.

## Alternatives considered

- **pgvector in the same database.** Keeps one datastore but still needs an embedding
  provider and its quota per upload; a natural extension if lexical search falls short.
- **A hosted vector database.** One more vendor holding copies of private documents.
- **Sending whole documents every turn.** Burns the context window and the allowance.
