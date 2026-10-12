# Review a synthetic request

> NOT EXECUTABLE / NOT DEPLOYED. Status: needs_clarification. 3 unresolved questions.
> Opaque evidence references resolve only in the originating installation. Exported files cannot be recalled by a local reset.

SANITIZED DOCUMENTATION SAMPLE. Not recorded evidence or live AI output.

## Goal
Review a synthetic request

## Non-goals
- No execution, deployment, replay, or autonomous browser actions.

## Inputs
- None specified (review required).

## Steps
- review: Confirm intent, required inputs, and business rules with the user.; depends on: none; evidence: sample-occurrence

## Capabilities (all unverified)
- None specified (review required).

## Rules
- None specified (review required).

## Outputs
- A reviewed proposal; no changes to external systems.

## Success criteria
- The user confirms intent, rules, and outputs.

## Approval requirements
- Human review of every proposed external change.

## Prohibited actions
- Do not execute this definition.
- Do not access credentials or perform irreversible actions.

## UNRESOLVED QUESTIONS
- What outcome is intended?
- Which inputs and business rules are required?
- What capabilities and approvals would deployment need?

## Savings assumptions
- Observed approximate mean active time: 18000 ms
- Assumed remaining human review: 18000 ms
- Assumed savings per occurrence: 0 ms
- No savings established. Remaining review time defaults to all observed active time; edit assumptions explicitly. No weekly projection.

## Versioned definition (same validated object as JSON export)

```json
{
  "title": "Review a synthetic request",
  "description": "SANITIZED DOCUMENTATION SAMPLE. Not recorded evidence or live AI output.",
  "goal": "Review a synthetic request",
  "nonGoals": [
    "No execution, deployment, replay, or autonomous browser actions."
  ],
  "inputs": [],
  "steps": [
    {
      "id": "review",
      "instruction": "Confirm intent, required inputs, and business rules with the user.",
      "dependsOn": [],
      "evidenceRefs": [
        "sample-occurrence"
      ]
    }
  ],
  "capabilities": [],
  "rules": [],
  "outputs": [
    "A reviewed proposal; no changes to external systems."
  ],
  "successCriteria": [
    "The user confirms intent, rules, and outputs."
  ],
  "approvalRequirements": [
    "Human review of every proposed external change."
  ],
  "prohibitedActions": [
    "Do not execute this definition.",
    "Do not access credentials or perform irreversible actions."
  ],
  "questions": [
    "What outcome is intended?",
    "Which inputs and business rules are required?",
    "What capabilities and approvals would deployment need?"
  ],
  "schemaVersion": "1.0",
  "id": "sample-definition",
  "version": 1,
  "status": "needs_clarification",
  "provenance": {
    "workflowId": "sample-workflow",
    "occurrenceRefs": [
      "sample-occurrence"
    ],
    "occurrenceCount": 1,
    "approximateMeanActiveMs": 18000,
    "interpretationVersion": 0,
    "feedbackVersion": 1,
    "source": "manual",
    "evidenceScope": "Opaque references resolve only in this installation. Not executable or deployed."
  },
  "savings": {
    "remainingHumanReviewMs": 18000,
    "assumedSavingsPerOccurrenceMs": 0,
    "note": "No savings established. Remaining review time defaults to all observed active time; edit assumptions explicitly. No weekly projection."
  }
}
```
