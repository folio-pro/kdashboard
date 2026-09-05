# kdashboard

A Kubernetes desktop dashboard. This context covers the whole app; the terms below currently focus on the embedded AI agent feature.

## Language

### AI Agent

**Agent**:
A third-party AI CLI (e.g. `claude`, `codex`) the user runs inside kdashboard to inspect and reason about the cluster.
_Avoid_: bot, assistant, copilot

**Agent Profile**:
The description of one supported agent CLI: its name, binary, and how to hand it a prompt and tool access.
_Avoid_: provider, integration

**Agent Session**:
One live run of an Agent inside kdashboard, tied to the cluster context it was started against.

**Quick Action**:
A predefined, resource-aware entry point that starts an Agent Session with a prompt about the selected resource (e.g. "analyze this pod's logs").
_Avoid_: shortcut, preset

**Safe Mutation**:
A cluster-changing operation from the small allowed set (scale a workload, restart a rollout, delete a pod, update container resources) that an Agent may request. Anything outside the set is not available to Agents.
_Avoid_: write operation, apply

**Mutation Approval**:
The user's in-app approve/deny decision on a Safe Mutation an Agent has requested. Required by default; can be switched off in settings.
_Avoid_: confirmation, consent
