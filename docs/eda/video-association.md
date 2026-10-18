# Video Resource Coordination

Core Appointment prepares a durable intent with actor/source/target versions,
selection hash and lineage. Video verifies that intent and reserves exactly one
manual/generated resource, or a real no-resource receipt for in-person visits.
EHR transport cannot start before this preparation is verified. No URL, credential
or clinical payload is stored in Core workflow receipts.

After Core commits approval, Video validates the committed receipt, claims the
reserved generation and finalizes the resource in one Integrations transaction
with minimal facts and one audit intent. Core then acknowledges the scalar
consultation pointer and finalization state. If Core acknowledgement fails, the
finalized hold remains recoverable. Once acknowledged it leaves the worker scan.
Replays do not repeat claims or emit duplicate audit events.

Reschedule uses a distinct preparation hold, then the durable Core pivot, then
resource transfer. Finalization verifies saga, original/replacement versions,
request hash, lineage, association, freeze token and committed participant
receipt. The provider-origin appointment, room identifier and link are preserved.
Historical consultations remain on their originating appointment. Replacement
consultations reference the same Video resource with a newer association version.

Abort requires Core abandonment/compensation without a pivot. Lease/clock expiry
alone does not prove abandonment. Unknown EHR preparation holds stay reserved
until authorized recovery resolves the existing operation. The shared worker
scans bounded batches, rotates blocked entries to avoid starvation and retries
forward after a pivot. It never creates meetings or clinical records.

All public authority comes from current Core roles/ownership plus the existing
signed process-mTLS actor assertions. API and worker use the same implementation;
there is no fake runtime participant or legacy-writer bridge. Incomplete composed
views, Messaging and SSE remain gated. Backend-only fixture tests live in
`test/eda-video-association.test.ts`; actual database/broker/mTLS acceptance is
still deferred and target flags remain off.
