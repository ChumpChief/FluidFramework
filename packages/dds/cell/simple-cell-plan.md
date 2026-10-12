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
Do not build a general-purpose DDS framework or migrate other DDSs as part of this experiment.

## Proposed structure

```text
Application
    |
    v
SimpleCell<T>  <---->  Fluid adapter  <---->  Fluid runtime
    |
    +-- value, edits, events, operations, pending edits, acknowledgments
```

The adapter contains a `SimpleCell`; it does not become the Cell by forwarding or merging all of its properties.
The application can use the same Cell API with or without Fluid.
A small replication-control interface may expose additional methods to the adapter, but it operates on the same Cell state and implementation.
It is not a separate value model or replication engine.

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

The proposed target is a runtime-facing `SimpleCellChannel<T>` and a distinct app-facing `SimpleCell<T>`.
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

## Decisions to resolve during the experiment

- What is the smallest host API that supports initial-state handoff, acknowledgments, and pending-edit replay?
- Which callback and submission failure rules should the new Cell guarantee?
- Should standalone values be unconstrained `T`, with serialization enforced by each host, or should the standalone API require a codec?
- What explicit channel entry-point contract gives local creation and remote handle resolution the same app-facing object semantics?

These are design questions for the prototype, not requirements to preserve the current inheritance-based architecture.

## Stage 1 implementation

The standalone prototype is in [src/simpleCell.ts](./src/simpleCell.ts).
It uses `createEmitter` and `Listenable` for eventing, but has no base class, runtime/channel interfaces, attribution, or codec requirement.
It is not yet exported through the package entry points.
The existing Cell and its factory remain unchanged.

### API and host contract

| API | Purpose |
| --- | --- |
| `new SimpleCell<T>(snapshot?)` | Creates a local-only Cell, optionally restoring sequenced state. |
| `get`, `set`, `delete`, `empty` | Reads and edits the visible value. |
| `events.on`, `events.off` | Subscribes to `valueChanged` and `delete`; `on` also returns an unsubscribe function. |
| `startReplication(submit)` | Installs a synchronous submission callback once and returns the initial snapshot. |
| `receive(operation)` | Processes a remote operation in sequencing order. |
| `acknowledge()` | Retires the oldest pending local edit without another data-change event. |
| `resubmit(operation)` | Publishes the host-supplied pending operation without applying it again or modifying the pending queue. |
| `replay(operation)` | Recreates a persisted pending edit, including publication. |
| `rollback()` | Removes the newest pending edit after the host withdraws it from delivery. |
| `getSnapshot()` | Captures sequenced state, excluding pending local edits. |
| `getPendingOperations()` | Captures pending operations in replay order. |

Values are unconstrained `T`.
Cell does not clone or encode them; callers must not mutate stored payloads.
Operation and snapshot encoding, transport identity, queuing, and duplicate suppression belong to the host.

The submission callback receives only an operation.
Cell has no operation tokens or identity lookups.
The host guarantees that acknowledgments arrive in submission order and rollback removes edits in reverse submission order.
Resubmission still flows through the DDS: the host supplies unacknowledged operations in submission order, and Cell republishes each through the callback.
Several resubmit calls can occur before any acknowledgment, so Cell uses the supplied operation rather than repeatedly reading the head of its pending queue.
During resubmission and replay, the host associates submissions with the original transport records instead of treating them as new edits.
This includes replayed edits that were already sequenced but had not been acknowledged locally before a restart.
The host must deliver each edit exactly once, as either a remote operation or a local acknowledgment.

### State and failure decisions

Cell keeps the latest sequenced value alongside its pending operations.
The visible value comes from the newest pending edit, when one exists.
Remote operations still update sequenced state underneath pending edits, so rollback can reveal the current shared value rather than an obsolete pre-edit value.
Both responsibilities remain in the same Cell implementation.

A checkpoint consists of the sequenced snapshot, pending operations, and host-owned delivery position and transport identities.
Restore the snapshot, start replication, and replay pending operations before catching up with later sequenced messages.
The visible value alone is not a sufficient checkpoint.

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
Cell trusts the host's operation ordering instead of validating operation identity.
The standalone implementation uses ordinary JavaScript errors; a future Fluid adapter owns Fluid-specific error classification.

The standalone cases and the in-memory ordered host are in [src/test/simpleCell.spec.ts](./src/test/simpleCell.spec.ts).
The host separates sequencing from delivery, retains a delivery cursor, queues disconnected edits, and preserves transport records across resubmission and replay to suppress duplicate delivery.
It uses no Fluid runtime mocks.
The adapter described below uses this same standalone implementation.

## Stage 2 implementation

[SimpleCellChannel](./src/simpleCellChannel.ts) implements `IChannel` and contains a `SimpleCell`.
[SimpleCellFactory](./src/simpleCellFactory.ts) creates and loads channels under the distinct `https://graph.microsoft.com/types/experimental-simple-cell` type.
These experimental types remain source-module exports, not package entry-point exports.
The adapter does not extend `SharedObject` or `SharedObjectCore`, use `SharedKernel`, or forward Cell methods onto itself.
The existing Cell implementation and its format remain unchanged.

### Runtime integration

The adapter starts Cell replication when the channel is bound, has services, and its data store is attaching or attached.
Creation in an already-attached data store does not make an unbound channel replicated.
Before attachment, local edits are represented in the attach snapshot.
Disconnection does not stop replication: the runtime continues to accept pending operations and requests their resubmission later.

Incoming message collections map local messages to `acknowledge()` and remote messages to `receive(operation)`.
Resubmission calls `resubmit(operation)`, and rollback calls `rollback()`.
Attached stashed-op replay calls `replay(operation)`.
Detached replay applies ordinary local edits without creating pending operations.
The existing runtime capture mechanism associates replayed submissions with the original operation; the adapter introduces no operation tokens.

Snapshots use one `header` blob containing Cell's sequenced state.
Pending local edits are restored through the runtime's pending-state replay rather than being written into that blob.
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
The adapter also honors the runtime mode in which submission binds handles but the container runtime performs encoding.
GC visits both the sequenced state and pending operation values without binding or attaching objects.
This retains references that can become visible after acknowledgment or rollback.

### Scope and limitations

Stage 2 initially exposed the adapter through handles and used `channel.cell` for application access.
Stage 3, described below, changes handle resolution and provides an application-facing creation helper.

Squashed resubmission is explicitly unsupported and throws before submitting anything.
The adapter reuses staging-aware handle binding, but does not claim to support committing staging changes through squashed operations.
SharedObject-specific `pre-op`/`op` events and sampled callback telemetry are not reproduced.

[Adapter coverage](./src/test/simpleCellChannel.spec.ts) exercises attachment, detached loading, concurrent edits, disconnection, resubmission, rollback, summaries, nested handles, and GC.
It also exercises creation, cyclic reference attachment, serialized handle resolution, and stashed-op capture through the real `FluidDataStoreRuntime`.

## Stage 3 implementation

The runtime-facing adapter and the app-facing Cell now have distinct roles in creation and handle resolution.
Cell behavior, operation format, and snapshot format are unchanged.

### Channel entry-point contract

`ChannelWithEntryPoint<T>` is an internal, opt-in extension of `IChannel` in `datastore-definitions`.
It supplies a stable `entryPoint` object and a handle that resolves to that same object.
`SimpleCellChannel.entryPoint` returns its contained Cell typed as `SimpleCellView`.
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
The adapter retains the full `SimpleCell` through its `cell` property for host operations.
This is a TypeScript interface boundary, not a runtime wrapper: the view and implementation are the same object, preserving handle identity and event subscriptions.

### Scope

This is an opt-in runtime experiment, not a migration of every DDS.
The adapter requires the updated runtime for serialized handles to resolve to Cell.
No compatibility negotiation with older runtimes is added.
The general `SharedObjectKind` creation/type-check helpers and `fluid-static` initial-object APIs remain unchanged.
They still assume loadable application objects and need a separate design before adopting this model.

Integration coverage includes creation through the new helper, attachment through a legacy Cell, local and serialized handle identity, lazy loading in another runtime, continued edits and summaries through the retained adapter, and legacy channels resolving to themselves.
