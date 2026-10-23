# SimpleCell separation experiment

This is an exploration plan, not a commitment to a supported API.
The goal is to establish a new pattern for a distributed data structure (DDS) that works without the Fluid runtime and can also participate in Fluid through an adapter.

## Scope

- Add an experimental `SimpleCell` beside the existing Cell, leaving the existing implementation unchanged.
- Keep value storage, editing, events, and replication/op handling together in `SimpleCell`.
- Omit attribution entirely, including its options, metadata, and snapshot fields.
- Do not use `SharedKernel`, `makeSharedObjectKind`, or API grafting.
- Do not derive `SimpleCell` or its adapter from `SharedObject` or `SharedObjectCore`.
- Allow breaking API and format changes in the experiment.
  Do not add compatibility wrappers or preserve existing interfaces merely to avoid a breaking change.

Use Cell's behavior as a reference, not its class hierarchy as a template.
Keep reusable abstractions grounded in this experiment rather than building a general-purpose DDS framework.
The exploration has extracted a generic ordered-operation contract and Fluid adapter, exercised by Cell and a test-only log.
Do not migrate other production DDSs as part of this experiment.

## Current structure

```text
Application                                    Fluid runtime
    |                                                |
    | SimpleCellView<T>                              | IChannel
    v                                                v
+------------------------------+       +------------------------------+
| SimpleCell<T>                |       | DdsChannel<TView>            |
|                              |       |                              |
| App-facing interface:        |       | Generic Fluid adapter        |
|   SimpleCellView<T>           |       |                              |
|                              |<----->| Uses ReplicatedDataStructure |
| Host-facing interface:       |       | for replication and state    |
|   ReplicatedDataStructure    |       |                              |
|                              |       | entryPoint and handle.get()  |
| Value, edits, events, ops,    |<------| expose the app-facing view   |
| pending edits, ack/rollback  |       |                              |
+------------------------------+       +------------------------------+
       One Cell instance
```

`DdsChannel<TView>` is generic: it has no Cell-specific imports or knowledge of Cell operations and snapshots.
A `DataStructureDefinition<TView>` creates or restores `{ dds, value }` for the adapter.
The adapter retains `dds` through the host-facing `ReplicatedDataStructure` contract and exposes `value` as its application entry point.
For Cell, both are the same `SimpleCell<T>` instance, exposed through different interfaces; there is no separate view wrapper, value model, or replication engine.
The generic contract also permits distinct DDS and application objects.

Applications use `SimpleCellView<T>` for ordinary Cell operations, with the same API available in standalone use.
The adapter does not become the Cell by forwarding or merging its properties.
The Fluid creation helper returns `{ value, handle }`; both local and serialized handle resolution return the application-facing Cell.
The runtime retains the adapter for channel management.

| SimpleCell owns | Fluid adapter owns |
| --- | --- |
| `get`, `set`, `delete`, `empty`, and data-change events | Channel identity, attributes, factory, and runtime registration |
| Operation definitions and optimistic local edits | Translation of Fluid message collections into Cell inputs |
| Ordered pending edits and acknowledgment handling | Operation submission, transport identity, and runtime callbacks |
| Application of remote operations, replay, and rollback | Attachment, connection, and disposal integration |
| State capture and restoration | Storage access, summary trees, and snapshot encoding |
| Values treated as opaque payloads | Fluid value restrictions, handle encoding/binding, and garbage collection (GC) |

`SimpleCell` must not import Fluid runtime, channel, serializer, handle, summary, or telemetry types.
Reuse `createEmitter` from `@fluid-internal/client-utils` and the shared `Listenable` type for eventing.
The separation goal is independence from the runtime, not from common Fluid utilities.
Keep the adapter in a separate module so importing the standalone implementation does not load Fluid integration code.
This first experiment can remain in the Cell package; a separately publishable package is a later decision.

## Cell-to-host boundary

Define only the capabilities needed by Cell, rather than passing a smaller-looking runtime object into its constructor.
The initial boundary should support the following interactions:

- Publish a locally generated operation.
  Cell owns pending-edit bookkeeping; the host owns operation identity and guarantees acknowledgment and rollback ordering.
- Resubmit a host-supplied operation through the DDS.
  Cell republishes it without applying it again; other DDSs can perform their own resubmission processing.
- Receive an ordered remote operation or a local acknowledgment.
  Fluid envelopes, client identifiers, and message batching stay outside Cell.
- Replay a pending edit as a local edit, or roll back a local edit.
  These actions remain Cell behavior, even when the request originates in the runtime.
- Capture and restore Cell state as plain data.
  The adapter owns encoding and storage; Cell does not return a Fluid summary or read a blob.
- Move from local-only operation to replicated operation.
  The host supplies this transition without exposing Fluid attachment state to Cell.

The standalone contract assumes a host that delivers operations in a consistent total order and identifies local acknowledgments.
It is not an unordered peer-to-peer merge protocol.
Specify how the host prevents duplicate application across reconnect and pending-edit replay.

Distinguish local-only operation from temporary disconnection.
Before replication starts, edits update the value without accumulating operations that await acknowledgment.
When a replicated Cell is disconnected, edits still produce operations, and its host queues them.
Starting replication must establish an initial state before subsequent operations are delivered.
For Fluid, the adapter maps this to the channel's attach snapshot and operation stream.

## Behavioral baseline

Retain the useful behavior of Cell without copying its implementation details:

- Local edits update the visible value immediately.
- Pending local edits protect the visible value from earlier remote operations.
  Acknowledgments retire pending edits without applying them or emitting data-change events again.
- Once pending edits are acknowledged, subsequent remote operations apply in order.
- Reconnection resubmits pending operations without creating new logical edits.
- Rollback restores the preceding value and leaves pending-edit bookkeeping consistent.
- `undefined` represents an empty Cell.
  Preserve the distinction between a set event and a delete event, including `set(undefined)`.

Define the order of state updates, pending-edit registration, operation publication, and user callbacks explicitly.
Include nested edits from event listeners and failures during publication or callbacks.
Do not let an adapter silently drop an operation after Cell records it as pending.
Keep Fluid error reporting at the adapter boundary, while making failures observable in standalone use.

For the first version, use the same supported snapshot points as the Fluid integration.
Do not assume that a snapshot of the visible value also captures pending edits.
Document the separate state and replay information needed to restore a replica with unacknowledged operations.

## Runtime-facing identity

The target is a runtime-facing `DdsChannel<SimpleCellView<T>>` and a distinct app-facing `SimpleCell<T>`.
Only the adapter implements `IChannel` and the loadable/handle contracts required by Fluid.
The Cell does not implement `IChannel`, `ISharedObject`, or `IFluidLoadable`.

Make the app-facing object an explicit channel entry point for the experiment.
Channel factories and runtime management retain the adapter; app-facing creation and handle resolution return its Cell.
Wire both in-memory handles and serialized/remote handle resolution to that entry point.
Do not change only what a local handle returns: current channel-route resolution returns the channel itself.

This can require changes to channel contracts, creation helpers, and runtime routing.
Breaking changes are acceptable, but keep changes tied to this object separation.
Do not graft Cell methods onto the adapter to preserve the old same-object assumption.

## Implementation stages

### 1. Establish the standalone Cell

Add `src/simpleCell.ts` with the combined value and replication implementation and small host-facing types.
Use [the current Cell](./src/cell.ts) as the algorithm reference, removing attribution and Fluid dependencies rather than subclassing it.
Keep related types together until a separate file provides a clear benefit.

Add standalone tests and a small in-memory ordered host.
Demonstrate local-only use, two-replica convergence, multiple pending edits, disconnection, resubmission, rollback, and state restoration without any Fluid runtime mocks.
Use these cases to refine the boundary before implementing Fluid integration.

### 2. Implement the Fluid adapter through composition

Add an adapter and factory with a distinct experimental channel type.
Do not register it as the existing Cell type or imply compatibility with existing Cell snapshots.
Translate runtime callbacks into the standalone protocol without moving Cell's conflict resolution into the adapter.

Implement lifecycle, submission, loading, summarization, and GC through composition.
Reuse suitable functions and helpers, but inspect their assumptions first.
In particular, existing handle helpers depend on shared-object binding behavior; they are not automatically usable by an arbitrary `IChannel`.
Extract narrowly scoped services if needed instead of copying `SharedObject` wholesale.

Start adapter integration with plain serializable values, then cover handles and nested handles.
Handle serialization also binds referenced objects and affects attachment and GC.
The adapter is not complete until those behaviors work without adding handle knowledge to Cell.

### 3. Separate runtime and application objects

Introduce the explicit channel entry point and update creation and resolution paths to use it.
Demonstrate that the runtime manages the adapter while applications edit the contained Cell.
A handle must resolve to the intended app-facing object both before serialization and after loading on another client.

Do not make application code reach through a channel to use ordinary Cell operations.
Fluid-specific access, such as obtaining a handle, should be available through the integration API rather than added to the standalone Cell.

### 4. Evaluate the boundary

Run the standalone behavior cases and Fluid integration cases against the new implementation.
Cover attachment after local edits, edits while disconnected, pending-state replay, rollback followed by remote edits, snapshot loading, referenced-object attachment, and GC.
Keep existing Cell coverage to detect unintended changes to shared infrastructure.

Review the resulting imports and object graph.
You should be able to construct, edit, replicate, and restore `SimpleCell` without constructing or mocking any Fluid object.
The Fluid adapter should own integration policy, not a second implementation of Cell's algorithm.

Record what the experiment establishes and which remaining dependencies prevent independent packaging.
Do not generalize the adapter into a new framework until this concrete implementation exposes a useful reusable boundary.

## Provisional decisions and remaining questions

The prototype has selected the following answers, detailed in the implementation sections below:

- **Host boundary:** `ReplicatedDataStructure` covers replication startup, operation delivery, resubmission, replay, rollback, snapshots, and retained reference data.
  The host establishes initial shared state and owns transport identity, delivery ordering, and duplicate suppression.
  This boundary is exercised by Cell and a test-only log; it is not established as sufficient for other production DDSs.
- **Failure rules:** publication and listener failures propagate and permanently fault Cell.
  Submission must synchronously accept or queue operations and must not reenter editing or replication methods.
  Event listeners may make nested edits.
- **Values and encoding:** standalone values are unconstrained `T`, without a codec requirement.
  Each host owns encoding and payload restrictions; Cell validates its own operation structure.
- **Application identity:** `ChannelWithEntryPoint<T>` separates the runtime channel from its application value.
  The creation helper returns the scoped application value and its handle, and both local and serialized handles resolve to that value.

Remaining questions include whether this boundary generalizes to DDSs needing batching or sequencing information, how to support multipart and asynchronous or incremental snapshots, and how creation APIs such as `SharedObjectKind` and `fluid-static` should adopt separate application objects.
Independent packaging also remains a later decision.
These are provisional choices for the experiment, not commitments to a supported API or requirements to preserve the current inheritance-based architecture.

## Stage 1 implementation

The standalone prototype is in [src/simpleCell.ts](./src/simpleCell.ts).
It uses `createEmitter` and `Listenable` for eventing, but has no base class, runtime/channel interfaces, attribution, or codec requirement.
It is not yet exported through the package entry points.
The existing Cell and its factory remain unchanged.

### API and host contract

| API | Purpose |
| --- | --- |
| `new SimpleCell<T>(snapshot?)` | Creates a local-only Cell, optionally restoring a visible value. |
| `get`, `set`, `delete`, `empty` | Reads and edits the visible value. |
| `events.on`, `events.off` | Subscribes to `valueChanged` and `delete`; `on` also returns an unsubscribe function. |
| `startReplication(submit)` | Installs a synchronous submission callback once and returns the initial snapshot. |
| `receive(operation, local, localMetadata)` | Processes a remote operation when no local edits are pending, or acknowledges the oldest pending edit using its message ID. |
| `resubmit(operation, localMetadata, squash?)` | Publishes the host-supplied operation and metadata without applying it again or modifying the pending queue. Squash requests preserve operations unchanged. |
| `replay(operation)` | Recreates a persisted edit; publishes it only if replication has started. |
| `rollback(operation, localMetadata)` | Validates the newest pending message ID and restores the previous value recorded in its local metadata. |
| `getSnapshot()` | Captures the current visible value, including pending local edits. |
| `getPendingOperations()` | Captures pending operations in replay order. |
| `getReferenceData()` | Exposes visible data, pending operations, and previous values retained for rollback. |

Values are unconstrained `T`.
Cell does not clone or encode them; callers must not mutate stored payloads.
Operation and snapshot encoding, transport identity, queuing, and duplicate suppression belong to the host.
`receive`, `resubmit`, and `replay` accept unknown contents after host-specific decoding.
Cell validates and interprets its operation tags and fields; it does not decode or validate the opaque payload value's type.

Operations use the existing Cell's `setCell` and `deleteCell` tags.
Set operations wrap their payload as `{ type: "setCell", value: { value } }`, including when the value is undefined.
The submission callback receives an operation and opaque local metadata containing `pendingMessageId` and `previousValue`.
Message IDs match acknowledgments and rollback requests to pending edits; they are not transport identities and do not perform deduplication.
The host guarantees that acknowledgments arrive in submission order and rollback removes edits in reverse submission order.
Resubmission still flows through the DDS: the host supplies unacknowledged operations in submission order, and Cell republishes each through the callback.
Several resubmit calls can occur before any acknowledgment, so Cell uses the supplied operation rather than repeatedly reading the head of its pending queue.
During resubmission and replay, the host associates submissions with the original transport records instead of treating them as new edits.
This includes replayed edits that were already sequenced but had not been acknowledged locally before a restart.
The host must deliver each edit exactly once, as either a remote operation or a local acknowledgment.

### State and failure decisions

Cell keeps a visible value and pending operations with their local metadata, matching the existing Cell's value and rollback behavior.
Remote operations are ignored while local edits are pending; they are not retained in a separate sequenced value.
Acknowledgments retire pending operations without changing the visible value.
Rollback restores the previous value captured when the edit was made, not a remote value ignored while the edit was pending.

Snapshots capture the visible value and do not contain pending metadata or delivery state.
To replay pending edits and reconstruct their rollback values, the host must select a baseline preceding those edits and retain the pending operations, delivery position, and transport identities.
Restore that baseline, start replication, and replay pending operations before catching up with later messages.
Do not use a visible snapshot containing pending edits as their rollback reconstruction baseline.

Local edits update state and register pending work before calling the submission callback, then notify listeners.
The callback must accept or queue the operation synchronously, even while disconnected.
It may read the Cell, but must not invoke editing or replication methods until it returns.
This is a host precondition; Cell does not enforce it with a reentrancy guard.
Listeners can make nested edits; those edits publish after the outer edit, with synchronous, depth-first event notification.
Listener dispatch follows `createEmitter` semantics: an exception that escapes a listener stops the emission.
If a listener catches a nested failure, the emitter can finish notifying other listeners, but Cell remains faulted and rethrows at the end of the emission.

Publication and listener failures propagate and permanently fault the Cell.
Further edits, replication calls, and checkpoint requests throw an error whose cause is the first failure.
`get` and `empty` remain available for inspection.
Invalid lifecycle calls and attempts to acknowledge or roll back an empty pending queue throw before mutation and do not independently fault the Cell.
Malformed operation contents throw a `TypeError` before changing state or publishing.
Cell validates pending message IDs before changing acknowledgment or rollback state.
The host still owns transport ordering and duplicate suppression.
The standalone implementation uses ordinary JavaScript errors; a future Fluid adapter owns Fluid-specific error classification.

The standalone cases and the in-memory ordered host are in [src/test/simpleCell.spec.ts](./src/test/simpleCell.spec.ts).
The host separates sequencing from delivery, retains a delivery cursor, queues disconnected edits, and preserves transport records across resubmission and replay to suppress duplicate delivery.
It uses no Fluid runtime mocks.
The adapter described below uses this same standalone implementation.

## Stage 2 implementation

Stage 2 introduced a Cell-specific channel, now replaced by [DdsChannel](./src/ddsChannel.ts), a generic adapter.
[SimpleCellFactory](./src/simpleCellFactory.ts) creates and loads Cells through this adapter under the distinct `https://graph.microsoft.com/types/experimental-simple-cell` type.
These experimental types remain source-module exports, not package entry-point exports.
The adapter does not extend `SharedObject` or `SharedObjectCore`, use `SharedKernel`, or forward Cell methods onto itself.
The existing Cell implementation and its format remain unchanged.

### Runtime integration

The adapter starts Cell replication when the channel is bound, has services, and its data store is attaching or attached.
Creation in an already-attached data store does not make an unbound channel replicated.
Before attachment, local edits are represented in the attach snapshot.
Disconnection does not stop replication: the runtime continues to accept pending operations and requests their resubmission later.

Incoming message collections pass each operation's contents through `serializer.decode()` and then forward them with the `local` flag and local metadata to `receive(operation, local, localMetadata)`.
Resubmission calls `resubmit(operation, localMetadata, squash)`, and rollback calls `rollback(operation, localMetadata)`.
Rollback contents also pass through `serializer.decode()` before reaching the DDS.
Stashed-op replay always calls `replay(operation)`.
Cell handles replay in both states: detached replay updates local state without pending operations, while replicated replay also submits the edit.
The channel does not inspect Cell operation tags or fields, including during detached replay.
The existing runtime capture mechanism associates replayed submissions with the original operation; the adapter introduces no operation tokens.

Snapshots use one `header` blob containing Cell's visible value, matching the existing Cell's format without attribution.
The value can reflect pending local edits, but their bookkeeping is not written into that blob.
The runtime's pending-state replay reconstructs local metadata from its restore baseline.
The factory rejects unsupported channel types and snapshot versions.
Runtime-facing operations reject a disposed runtime, and disposal removes a pending attachment listener.
The retained Cell can still be inspected; an attempted replicated edit after disposal fails through its submission callback and faults the Cell.

### Reused helpers

The adapter composes the existing `SharedObjectHandle`, `FluidSerializer`, and `GCHandleVisitor` helpers.
`SharedObjectHandle` accepts a channel with `bindToContext()` rather than requiring all of `ISharedObject`.
Its binding and attachment behavior is unchanged.
Stage 3 separates its application-facing value from that channel.
`ISharedObjectHandle` describes the binding capability without constraining the type of the referenced object.
The handle and GC visitor are exposed through the shared-object-base internal entry point.

Operations and snapshots use Fluid handle encoding, decoding, and reference binding.
For operations, the channel only performs Fluid serialization; Cell owns further parsing and interpretation.
The adapter also honors the runtime mode in which submission binds handles but the container runtime performs encoding.
GC visits the DDS's `getReferenceData()` result without binding or attaching objects.
For Cell, this includes the visible value, pending operation values, and previous values retained for rollback.
This retains references that can become visible after acknowledgment or rollback.

### Scope and limitations

Stage 2 initially exposed the adapter through handles and used `channel.cell` for application access.
Stage 3, described below, changes handle resolution and provides an application-facing creation helper.

Stage 2 initially rejected squashed resubmission before submitting anything.
The generic adapter extension described below now forwards squash requests to the DDS and retains staging-aware handle binding.
SimpleCell preserves its operations unchanged rather than removing intermediate edits.
SharedObject-specific `pre-op`/`op` events and sampled callback telemetry are not reproduced.

[Adapter coverage](./src/test/simpleCellChannel.spec.ts) exercises attachment, detached loading, concurrent edits, disconnection, resubmission, rollback, summaries, nested handles, and GC.
It also exercises creation, cyclic reference attachment, serialized handle resolution, and stashed-op capture through the real `FluidDataStoreRuntime`.

## Stage 3 implementation

The runtime-facing adapter and the app-facing Cell now have distinct roles in creation and handle resolution.
Cell behavior, operation format, and snapshot format are unchanged.

### Channel entry-point contract

`ChannelWithEntryPoint<T>` is an internal, opt-in extension of `IChannel` in `datastore-definitions`.
It supplies a stable `entryPoint` object and a handle that resolves to that same object.
The Cell definition supplies a `SimpleCellView` as `DdsChannel.entryPoint`.
The adapter still implements the runtime's channel/loadable contract; the Cell does not acquire those interfaces.

The data store runtime uses the entry point when resolving a channel path.
Channels without an entry point continue to resolve to themselves.
`runtime.createChannel()` and `runtime.getChannel()` still return the adapter, and the runtime retains it for operation processing, attachment, summaries, and GC.
Factories continue to create and load channels rather than application objects.

`SharedObjectHandle` now takes a channel and a separate resolved value.
Attachment and reference binding use the channel, while `get()` returns the value.
Existing SharedObjects pass themselves for both roles.
SimpleCell passes its adapter as the channel and its Cell as the value.
Both local handles and serialized handles therefore return the Cell within the corresponding runtime.
Loading the same document in another runtime creates a different local Cell instance, as expected.

### Application-facing creation

`createSimpleCell(runtime, id?)`, in [simpleCellFactory.ts](./src/simpleCellFactory.ts), returns `{ value, handle }`.
The value is a `SimpleCellView<Serializable<unknown>>`, and the handle resolves to that same scoped interface.
Register `SimpleCellFactory` with the runtime before calling it.
The helper uses `runtime.createChannel()` so the adapter remains registered even though the return value does not expose it.
The experimental helper and Cell types remain source-module exports, not package entry-point exports.

```typescript
const { value: cell, handle } = createSimpleCell(runtime, "cell");
cell.set(42);

// Store the handle in an attached object to share the Cell.
parent.set(handle);

const resolvedCell = await handle.get();
resolvedCell.set(43);
```

No `.handle`, `IFluidLoadable`, or runtime management methods are added to Cell.
The creation result keeps Fluid-specific access beside the application value.

`SimpleCellView<T>` exposes only `get`, `set`, `delete`, `empty`, and data-change events.
It does not expose replication setup, message processing, acknowledgment, resubmission, replay, rollback, or snapshots.
The adapter retains the DDS implementation through its `dds` property and its host-facing interface.
This is a TypeScript interface boundary, not a runtime wrapper: the view and implementation are the same object, preserving handle identity and event subscriptions.

### Scope

This is an opt-in runtime experiment, not a migration of every DDS.
The adapter requires the updated runtime for serialized handles to resolve to Cell.
No compatibility negotiation with older runtimes is added.
The general `SharedObjectKind` creation/type-check helpers and `fluid-static` initial-object APIs remain unchanged.
They still assume loadable application objects and need a separate design before adopting this model.

Integration coverage includes creation through the new helper, attachment through a legacy Cell, local and serialized handle identity, lazy loading in another runtime, continued edits and summaries through the retained adapter, and legacy channels resolving to themselves.

## Generic adapter experiment

The contract and adapter remain in the Cell package for now.
They are source-module exports, not new package entry-point exports.
No other production DDS is migrated in this experiment.

### Host-facing contract

[ReplicatedDataStructure](./src/replicatedDataStructure.ts) exposes replication startup, incoming operations, resubmission, replay, rollback, synchronous snapshots, and retained reference data.
The contract has no imports or Fluid-specific types.
`SimpleCell` implements it alongside `SimpleCellView`, keeping data and replication behavior in one implementation.

Rollback accepts decoded operation contents and local metadata so DDSs can interpret either.
Cell validates the operation and uses the metadata's pending message ID and previous value.
The contract retains the host guarantees about total ordering, acknowledgments, reverse-order rollback, and deduplication.

`getReferenceData()` returns data containing any external references still retained by the DDS.
It does not return Fluid handles or GC routes as a contract.
Cell returns visible and pending state, including rollback values; another DDS can also expose references in undo state or other retained structures.
The Fluid adapter uses `GCHandleVisitor` to interpret Fluid references in that data.

### Local operation metadata and resubmission

The submission callback accepts optional, opaque local metadata.
The host retains it without encoding, cloning, or sending it to other replicas.
The adapter returns the same value on local acknowledgment, resubmission, and rollback; remote operations carry no local metadata.
Only operation contents pass through the Fluid serializer.
Metadata may contain object identities and non-serializable bookkeeping.
The DDS remains responsible for exposing any retained references needed for garbage collection through `getReferenceData()`.

Resubmission receives the original operation's metadata and a boolean squash request.
The DDS may publish zero, one, or multiple replacement operations with their own metadata and must keep its pending state consistent with the resulting acknowledgments.
The adapter does not interpret the request or combine operations.
SimpleCell uses an ordered pending queue and submits the existing Cell's message ID and previous-value metadata.
It republishes operations with their original metadata unchanged even when squashing is requested.
No Cell compaction is implemented.

`replay(content)` is unchanged.
The DDS recreates local metadata when replay submits edits, and the runtime captures those submissions for the persisted transport record.
This preserves the existing stashed-operation handling without encoding or persisting the metadata itself.

### Construction and application views

`DataStructureDefinition<TView>` supplies `create()` and `restore(snapshot)`.
Both return `{ dds, value }`, with a host-facing DDS and a scoped application value.
These can be the same object or distinct objects.
Restoration receives contents after Fluid decoding and is responsible for DDS-specific snapshot validation.

The generic channel invokes the definition itself; factories do not supply already-constructed DDS instances.
`SimpleCellFactory` supplies a Cell-specific definition and retains registration attributes and format-version checks.
The definition creates an empty Cell or restores its existing snapshot shape.
The generic channel has no imports from Cell and does not interpret its operation tags, snapshot fields, or pending queue.
No operation codec is injected: DDSs interpret their own operation contents.

### Limits and evaluation

This adapter supports ordered operations with synchronous, non-undefined snapshots stored in one `header` blob.
Snapshot contents and the relationship between snapshots and pending replay are DDS-defined, not restricted to sequenced state.
It forwards opaque local metadata and squash requests while leaving their interpretation to the DDS.
Batching-specific behavior, sequencing information, and asynchronous or incremental snapshots are not added to the contract here.
Those require further design before adapting DDSs that need them.

The existing Cell integration cases now run through `DdsChannel`.
[Generic adapter coverage](./src/test/ddsChannel.spec.ts) uses a test log with different operation fields, array snapshots, and a separate application view.
It checks operation delivery, replay, resubmission, decoded rollback contents, and references retained only in undo state.
It also checks opaque metadata identity, squash forwarding, and metadata reconstruction through the real runtime's stashed-operation capture path.
The test log is not a new supported DDS; it checks that the adapter does not depend on Cell's data model.
Cell-specific coverage compares snapshots and pending/rollback behavior with the existing Cell and exchanges operations between the two implementations.

### Deferred: multipart snapshots

Revisit multipart snapshot support when exploring a DDS that already needs multiple blobs or child trees.
No multipart capability is implemented for now.
SimpleCell keeps its existing snapshot object, root-level `header` blob, and snapshot format version.

The direction to evaluate is to keep part selection, layout, and reconstruction private to the DDS rather than introduce a generic snapshot tree that the channel assembles.
`getSnapshot()` could return ordinary data for the adapter to serialize with `createSingleBlobSummary`, or a prebuilt `ISummaryTreeWithStats` that the adapter forwards unchanged.
The latter would let a DDS explicitly opt into Fluid's storage representation without requiring it of other DDSs.

Open questions include how to distinguish ordinary data from a prebuilt summary and how to preserve channel-owned handle serialization.
A channel-supplied `stringify(value)` callback could let a multipart DDS encode its blobs while constructing its own summary.
Loading should follow the same ownership boundary: the DDS chooses its parts and reconstructs state, while the adapter supplies decoded reads.
These are candidate directions, not settled contracts; asynchronous snapshot generation and incremental summary references remain separate concerns.
