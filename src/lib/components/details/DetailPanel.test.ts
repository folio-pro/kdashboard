import { describe, expect, test } from "bun:test";
import {
  deriveKind,
  deriveShowLogsButton,
  deriveNodeName,
  deriveResourceType,
  deriveIsScalable,
  deriveIsRestartable,
  deriveIsRollbackable,
  deriveCurrentReplicas,
  deriveAll,
} from "./detail-panel";

// =============================================================================
// Tests
// =============================================================================

describe("DetailPanel derived logic", () => {
  // -------------------------------------------------------------------------
  // Null / undefined resource
  // -------------------------------------------------------------------------
  describe("null/undefined resource", () => {
    test("null resource produces empty kind and no buttons", () => {
      const d = deriveAll(null);
      expect(d.kind).toBe("");
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(false);
      expect(d.isRestartable).toBe(false);
      expect(d.isRollbackable).toBe(false);
      expect(d.nodeName).toBe("");
      expect(d.currentReplicas).toBe(0);
    });

    test("undefined resource produces empty kind and no buttons", () => {
      const d = deriveAll(undefined);
      expect(d.kind).toBe("");
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(false);
      expect(d.isRestartable).toBe(false);
      expect(d.isRollbackable).toBe(false);
    });

    test("resource with undefined kind produces empty kind", () => {
      const d = deriveAll({ spec: {} });
      expect(d.kind).toBe("");
      expect(d.resourceType).toBe("s");
    });
  });

  // -------------------------------------------------------------------------
  // Kind normalization (case handling)
  // -------------------------------------------------------------------------
  describe("kind normalization", () => {
    test("kind is lowercased from PascalCase", () => {
      expect(deriveKind({ kind: "Pod" })).toBe("pod");
      expect(deriveKind({ kind: "Deployment" })).toBe("deployment");
      expect(deriveKind({ kind: "StatefulSet" })).toBe("statefulset");
      expect(deriveKind({ kind: "DaemonSet" })).toBe("daemonset");
    });

    test("kind is lowercased from UPPER CASE", () => {
      expect(deriveKind({ kind: "POD" })).toBe("pod");
      expect(deriveKind({ kind: "DEPLOYMENT" })).toBe("deployment");
    });

    test("already lowercase kind is unchanged", () => {
      expect(deriveKind({ kind: "pod" })).toBe("pod");
    });
  });

  // -------------------------------------------------------------------------
  // Resource type derivation (kind + "s")
  // -------------------------------------------------------------------------
  describe("resourceType derivation", () => {
    test("appends 's' to lowercased kind", () => {
      expect(deriveResourceType("pod")).toBe("pods");
      expect(deriveResourceType("deployment")).toBe("deployments");
      expect(deriveResourceType("statefulset")).toBe("statefulsets");
      expect(deriveResourceType("daemonset")).toBe("daemonsets");
      expect(deriveResourceType("replicaset")).toBe("replicasets");
    });

    test("empty kind produces just 's'", () => {
      expect(deriveResourceType("")).toBe("s");
    });
  });

  // -------------------------------------------------------------------------
  // showLogsButton visibility
  // -------------------------------------------------------------------------
  describe("showLogsButton", () => {
    test("shows for Pod", () => {
      expect(deriveAll({ kind: "Pod" }).showLogsButton).toBe(true);
    });

    test("shows for Deployment", () => {
      expect(deriveAll({ kind: "Deployment" }).showLogsButton).toBe(true);
    });

    test("hidden for StatefulSet", () => {
      expect(deriveAll({ kind: "StatefulSet" }).showLogsButton).toBe(false);
    });

    test("hidden for Service", () => {
      expect(deriveAll({ kind: "Service" }).showLogsButton).toBe(false);
    });

    test("hidden for DaemonSet", () => {
      expect(deriveAll({ kind: "DaemonSet" }).showLogsButton).toBe(false);
    });

    test("hidden for unknown kind", () => {
      expect(deriveAll({ kind: "CustomResource" }).showLogsButton).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isScalable
  // -------------------------------------------------------------------------
  describe("isScalable", () => {
    test("Deployment is scalable", () => {
      expect(deriveAll({ kind: "Deployment" }).isScalable).toBe(true);
    });

    test("StatefulSet is scalable", () => {
      expect(deriveAll({ kind: "StatefulSet" }).isScalable).toBe(true);
    });

    test("ReplicaSet is scalable", () => {
      expect(deriveAll({ kind: "ReplicaSet" }).isScalable).toBe(true);
    });

    test("DaemonSet is NOT scalable", () => {
      expect(deriveAll({ kind: "DaemonSet" }).isScalable).toBe(false);
    });

    test("Pod is NOT scalable", () => {
      expect(deriveAll({ kind: "Pod" }).isScalable).toBe(false);
    });

    test("Service is NOT scalable", () => {
      expect(deriveAll({ kind: "Service" }).isScalable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isRestartable
  // -------------------------------------------------------------------------
  describe("isRestartable", () => {
    test("Deployment is restartable", () => {
      expect(deriveAll({ kind: "Deployment" }).isRestartable).toBe(true);
    });

    test("StatefulSet is restartable", () => {
      expect(deriveAll({ kind: "StatefulSet" }).isRestartable).toBe(true);
    });

    test("DaemonSet is restartable", () => {
      expect(deriveAll({ kind: "DaemonSet" }).isRestartable).toBe(true);
    });

    test("ReplicaSet is NOT restartable", () => {
      expect(deriveAll({ kind: "ReplicaSet" }).isRestartable).toBe(false);
    });

    test("Pod is NOT restartable", () => {
      expect(deriveAll({ kind: "Pod" }).isRestartable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isRollbackable
  // -------------------------------------------------------------------------
  describe("isRollbackable", () => {
    test("Deployment is rollbackable", () => {
      expect(deriveAll({ kind: "Deployment" }).isRollbackable).toBe(true);
    });

    test("StatefulSet is NOT rollbackable", () => {
      expect(deriveAll({ kind: "StatefulSet" }).isRollbackable).toBe(false);
    });

    test("DaemonSet is NOT rollbackable", () => {
      expect(deriveAll({ kind: "DaemonSet" }).isRollbackable).toBe(false);
    });

    test("ReplicaSet is NOT rollbackable", () => {
      expect(deriveAll({ kind: "ReplicaSet" }).isRollbackable).toBe(false);
    });

    test("Pod is NOT rollbackable", () => {
      expect(deriveAll({ kind: "Pod" }).isRollbackable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Node name extraction
  // -------------------------------------------------------------------------
  describe("nodeName extraction", () => {
    test("extracts from spec.nodeName", () => {
      const d = deriveAll({ kind: "Pod", spec: { nodeName: "node-1" } });
      expect(d.nodeName).toBe("node-1");
    });

    test("falls back to status.nodeName when spec.nodeName is missing", () => {
      const d = deriveAll({ kind: "Pod", status: { nodeName: "node-2" } });
      expect(d.nodeName).toBe("node-2");
    });

    test("spec.nodeName takes precedence over status.nodeName", () => {
      const d = deriveAll({
        kind: "Pod",
        spec: { nodeName: "from-spec" },
        status: { nodeName: "from-status" },
      });
      expect(d.nodeName).toBe("from-spec");
    });

    test("empty string when pod is unscheduled (no nodeName anywhere)", () => {
      const d = deriveAll({ kind: "Pod", spec: {}, status: {} });
      expect(d.nodeName).toBe("");
    });

    test("empty string when spec and status are missing", () => {
      const d = deriveAll({ kind: "Pod" });
      expect(d.nodeName).toBe("");
    });

    test("non-pod resources can still have nodeName", () => {
      // Node resources sometimes carry nodeName in metadata, but the component
      // checks spec/status, so this tests a Deployment with spec.nodeName set
      const d = deriveAll({ kind: "Deployment", spec: { nodeName: "n1" } });
      expect(d.nodeName).toBe("n1");
    });
  });

  // -------------------------------------------------------------------------
  // currentReplicas
  // -------------------------------------------------------------------------
  describe("currentReplicas", () => {
    test("reads spec.replicas when present", () => {
      const d = deriveAll({ kind: "Deployment", spec: { replicas: 3 } });
      expect(d.currentReplicas).toBe(3);
    });

    test("defaults to 0 when spec.replicas is missing", () => {
      const d = deriveAll({ kind: "Deployment", spec: {} });
      expect(d.currentReplicas).toBe(0);
    });

    test("defaults to 0 when spec is missing entirely", () => {
      const d = deriveAll({ kind: "Deployment" });
      expect(d.currentReplicas).toBe(0);
    });

    test("defaults to 0 for null resource", () => {
      expect(deriveCurrentReplicas(null)).toBe(0);
    });

    test("handles replicas = 0 explicitly", () => {
      const d = deriveAll({ kind: "Deployment", spec: { replicas: 0 } });
      expect(d.currentReplicas).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Combined scenarios: full resource objects
  // -------------------------------------------------------------------------
  describe("combined scenarios", () => {
    test("Pod: logs + terminal visible, not scalable/restartable/rollbackable", () => {
      const d = deriveAll({
        kind: "Pod",
        spec: { nodeName: "worker-01" },
      });
      expect(d.showLogsButton).toBe(true);
      expect(d.isScalable).toBe(false);
      expect(d.isRestartable).toBe(false);
      expect(d.isRollbackable).toBe(false);
      expect(d.nodeName).toBe("worker-01");
    });

    test("Deployment: logs + scale + restart + rollback all visible", () => {
      const d = deriveAll({
        kind: "Deployment",
        spec: { replicas: 5 },
      });
      expect(d.showLogsButton).toBe(true);
      expect(d.isScalable).toBe(true);
      expect(d.isRestartable).toBe(true);
      expect(d.isRollbackable).toBe(true);
      expect(d.currentReplicas).toBe(5);
    });

    test("StatefulSet: scale + restart, no logs or rollback", () => {
      const d = deriveAll({
        kind: "StatefulSet",
        spec: { replicas: 3 },
      });
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(true);
      expect(d.isRestartable).toBe(true);
      expect(d.isRollbackable).toBe(false);
    });

    test("DaemonSet: restart only, not scalable or rollbackable", () => {
      const d = deriveAll({ kind: "DaemonSet" });
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(false);
      expect(d.isRestartable).toBe(true);
      expect(d.isRollbackable).toBe(false);
    });

    test("ReplicaSet: scalable only, no restart or rollback", () => {
      const d = deriveAll({ kind: "ReplicaSet", spec: { replicas: 2 } });
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(true);
      expect(d.isRestartable).toBe(false);
      expect(d.isRollbackable).toBe(false);
      expect(d.currentReplicas).toBe(2);
    });

    test("Service: no action buttons at all", () => {
      const d = deriveAll({ kind: "Service" });
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(false);
      expect(d.isRestartable).toBe(false);
      expect(d.isRollbackable).toBe(false);
    });

    test("unknown CRD kind: no action buttons", () => {
      const d = deriveAll({ kind: "VirtualService" });
      expect(d.showLogsButton).toBe(false);
      expect(d.isScalable).toBe(false);
      expect(d.isRestartable).toBe(false);
      expect(d.isRollbackable).toBe(false);
      expect(d.resourceType).toBe("virtualservices");
    });
  });
});
