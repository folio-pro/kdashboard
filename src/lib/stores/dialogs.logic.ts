import type { Resource } from "$lib/types";

export type ScaleResourceInfo = {
  kind: string;
  name: string;
  namespace: string;
  currentReplicas: number;
};

export class DialogStoreLogic {
  // Scale dialog
  scaleOpen = false;
  scaleResource: ScaleResourceInfo | null = null;

  // Delete confirmation dialog
  deleteOpen = false;
  deleteResource: Resource | null = null;

  // Drain dialog (nodes)
  drainOpen = false;
  drainNodeName: string | null = null;

  // Upsell dialog (feature gate)
  upsellOpen = false;

  // Compare dialog (diff a resource against its sibling in another namespace)
  compareOpen = false;
  compareResource: Resource | null = null;

  // Quick edit (image / env / resources without the YAML editor)
  quickEditOpen = false;
  quickEditResource: Resource | null = null;

  openScale(resource: Resource): void {
    this.scaleResource = {
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? "",
      currentReplicas: (resource.spec?.replicas as number) ?? 0,
    };
    this.scaleOpen = true;
  }

  closeScale(): void {
    this.scaleOpen = false;
    this.scaleResource = null;
  }

  openDelete(resource: Resource): void {
    this.deleteResource = resource;
    this.deleteOpen = true;
  }

  closeDelete(): void {
    this.deleteOpen = false;
    this.deleteResource = null;
  }

  openDrain(nodeName: string): void {
    this.drainNodeName = nodeName;
    this.drainOpen = true;
  }

  closeDrain(): void {
    this.drainOpen = false;
    this.drainNodeName = null;
  }

  openUpsell(): void {
    this.upsellOpen = true;
  }

  openCompare(resource: Resource): void {
    this.compareResource = resource;
    this.compareOpen = true;
  }

  closeCompare(): void {
    this.compareOpen = false;
    this.compareResource = null;
  }

  closeUpsell(): void {
    this.upsellOpen = false;
  }

  openQuickEdit(resource: Resource): void {
    this.quickEditResource = resource;
    this.quickEditOpen = true;
  }

  closeQuickEdit(): void {
    this.quickEditOpen = false;
    this.quickEditResource = null;
  }
}
