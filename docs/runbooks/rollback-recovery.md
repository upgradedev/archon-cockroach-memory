# Rollback and delivery recovery

Current capability: protected staging/production deployment, CodeDeploy
canaries, rollback alarms, durable recovery intents, and watchdog audit/recovery
workflows exist in `eu-west-1`.

Current limitation: the historical successful evidence proves terminal
`COMMITTED`/no-op watchdog behavior. It is not an intentionally fault-injected
`RECOVERING` to `RECOVERED` exercise.

## Trigger

- deployment failure or cancellation;
- nonterminal durable-recovery intent;
- failed canary or post-deploy smoke;
- CloudFormation drift or protection audit failure.

## Response

1. Preserve the source deployment run ID, attempt, SHA, environment, candidate
   identity, and durable-intent identifier.
2. Allow the existing `Recover AWS` workflow to classify the trusted
   default-branch source. Do not download and execute recovery code from an S3
   bundle or a laptop.
3. If classification is `noop`, verify the terminal receipt and drift result.
4. If classification is `recover`, require the protected environment and
   existing least-privilege role; monitor the exact workflow.
5. Verify application health, immutable receipt, lease release, idempotent
   reclassification, and no cross-environment mutation.
6. Escalate any failed or ambiguous finalization. `Unknown` is not recovered.

## Future fault-injection gate

A staging-only drill requires explicit approval and a dedicated workflow. It
must fail after a real controlled delivery mutation, prove CodeDeploy rollback,
show `RECOVERING → RECOVERED`, recheck API/UI/data health, and prove a second
run is idempotent. Production fault injection is outside this runbook.

No recovery path may introduce an application or recovery workload in
`us-west-2`.
