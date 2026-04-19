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

  // Upsell dialog (feature gate)
  upsellOpen = false;

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

  openUpsell(): void {
    this.upsellOpen = true;
  }

  closeUpsell(): void {
    this.upsellOpen = false;
  }
}
