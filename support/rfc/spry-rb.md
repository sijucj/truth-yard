# Spry-Orchestrated Execution via Truth Yard RFC

Spry already provides a programmable markdown environment for defining
workbooks, playbooks, and runbooks. Truth Yard already provides local-first
discovery, mounting, execution, and durable evidence storage across data sources
such as SQLite, DuckDB, and files.

This RFC proposes a synthesis:

- Spry is the orchestration specification
- Truth Yard is the runner, durability layer, and execution substrate
- Deno TypeScript is the extension and integration runtime

The goal is not to build another workflow product, but to make authored
operational intent in Spry directly executable, auditable, and composable using
Truth Yard’s existing strengths.

## Design Principles

- Local-first: everything must run locally without cloud dependencies
- Deterministic: the same inputs and state produce the same results
- Durable by default: all runs are persisted and replayable
- Evidence-driven: execution leaves a complete audit trail
- Webhook-native: all runbooks are invocable via HTTP
- Separation of concerns:

  - Spry defines what should happen
  - Truth Yard defines how it runs and is persisted

## High-Level Architecture

Components:

- Spry Runbooks Markdown-based artifacts defining triggers, inputs, steps, and
  policies

- Truth Yard Runner Discovers runbooks, exposes webhooks, executes steps,
  persists state

- Mounted Resources SQLite, DuckDB, files, and Spry content itself, all treated
  uniformly

- Execution Journal SQLite-backed tables capturing runs, steps, events, and
  artifacts

Flow:

1. Truth Yard scans for Spry workspaces

2. Runbooks are parsed into normalized execution graphs

3. Each runbook is exposed as a webhook endpoint

4. Webhook invocation creates a durable run

5. Steps are executed using mounted resources

6. State and outputs are persisted

7. Run can be observed, paused, resumed, or replayed

8. Runbook Model

Each runbook resolves to:

- Metadata id, name, tags, versionHash

- Triggers webhook, schedule, upstream run, manual

- Inputs Typed parameters with defaults

- Steps Ordered or graph-based execution units with:

  - type
  - input bindings
  - retry/backoff policy
  - timeout
  - required mounts

- Policies concurrency group, idempotency strategy, rate limits

- Outputs artifacts, dataset writes, summaries

The normalized model is persisted for audit and introspection.

## Execution Model

Run Lifecycle:

- Created Inputs validated, idempotency checked

- Running Steps executed via worker loop

- Waiting Paused for time, external callback, or human approval

- Completed All steps succeeded

- Failed Terminal failure after retries

Step Execution:

- Each step execution is isolated
- Inputs and outputs are recorded
- Failures trigger retry logic
- Side effects must be idempotent or guarded

## Durability and Evidence

All execution state is persisted in SQLite:

- Runs table
- Steps table
- Event journal
- Artifacts table
- Idempotency keys

This enables:

- Full auditability
- Deterministic replay
- SQL-native analysis
- UI generation via SQLPage

## Webhook Interface

Canonical endpoints:

- POST /runbooks/{id}/start
- POST /runs/{runId}/cancel
- POST /runs/{runId}/resume
- POST /runs/{runId}/callback/{token}
- POST /runs/{runId}/approve

All endpoints support:

- HMAC signatures
- Timestamps and replay protection
- Idempotency keys

## Mount and Binding Resolution

Runbooks do not reference concrete paths or connections. They reference named
mounts.

Truth Yard resolves mounts at execution time and injects them into step
contexts.

Spry content itself is treated as a mount, enabling runbooks to reference other
runbooks or shared assets.

## Observability

Minimum observability guarantees:

- Queryable run and step state
- Structured logs per step
- Timing and retry visibility
- Artifact inspection

Streaming updates (SSE/WebSocket) are optional but encouraged.

## Future Extensions

- Serverless hosting of the runner
- Distributed execution backends
- AI-assisted runbook authoring and validation
- Policy-as-code enforcement layers

## Success Criteria

This RFC is successful when:

- Engineers can author operational logic in Spry and run it immediately
- Truth Yard acts as a reliable, auditable execution engine
- Execution history becomes part of the evidence corpus
- The system remains simple, composable, and local-first
