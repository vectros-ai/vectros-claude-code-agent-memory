/**
 * `kind` AND `dest` OF A CANDIDATE ARE CLOSED SETS, and the capture step's model reply is the only thing that fills
 * them. The candidate record type refuses any other value, so an off-contract one (a typo, a sentence, a whole
 * paragraph the model was steered into writing) never became a record: it was sent in the request body, refused, and
 * retried as a poison entry. Both writes of a candidate normalise through these two functions: the mapping that
 * builds the queue event and the record (capture-map.mjs), and the one place every record is sent from (propose in
 * candidates.mjs), which also carries entries a previous version already put on disk.
 *
 * An off-contract `kind` is treated exactly like an absent one: `undefined`, so the key is dropped from the queue
 * line and the request. A dropped key is the safe answer for an enum, while a default would overwrite a value an
 * earlier attempt of the same upsert already stored. An off-contract `dest` becomes "no suggestion" (`null`), which
 * is what an absent one already meant.
 *
 * Its own module so that capture-map.mjs (which imports from candidates.mjs) and candidates.mjs can both use it
 * without importing each other.
 */
export const CANDIDATE_KINDS = new Set(['user', 'feedback', 'project', 'reference', 'observation']);
export const CANDIDATE_DESTS = new Set(['memory', 'doc']);

export const kindOf = (v) => (CANDIDATE_KINDS.has(v) ? v : undefined);
export const destOf = (v) => (CANDIDATE_DESTS.has(v) ? v : null);
