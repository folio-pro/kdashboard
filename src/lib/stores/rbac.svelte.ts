import { invoke } from "$lib/ipc/core";
import type { EffectivePermissions, RbacSubject, SubjectKind } from "$lib/types";

/** The RBAC explorer: the subject picker list and one resolved permission set. */
class RbacStore {
  subjects = $state.raw<RbacSubject[]>([]);
  subjectsLoading = $state(false);
  subjectsError = $state<string | null>(null);
  permissions = $state.raw<EffectivePermissions | null>(null);
  permissionsLoading = $state(false);
  permissionsError = $state<string | null>(null);
  private gen = 0;

  reset(): void {
    this.gen++;
    this.subjects = [];
    this.permissions = null;
    this.subjectsError = null;
    this.permissionsError = null;
    this.subjectsLoading = false;
    this.permissionsLoading = false;
  }

  async loadSubjects(namespace: string | null): Promise<void> {
    const g = ++this.gen;
    this.subjectsLoading = true;
    this.subjectsError = null;
    try {
      const list = await invoke<RbacSubject[]>("get_rbac_subjects", { namespace });
      if (g === this.gen) this.subjects = list;
    } catch (err) {
      if (g === this.gen) this.subjectsError = String(err);
    } finally {
      if (g === this.gen) this.subjectsLoading = false;
    }
  }

  async resolve(kind: SubjectKind, name: string, subjectNamespace: string | null, namespace: string | null, groups: string[] = []): Promise<void> {
    const g = ++this.gen;
    this.permissionsLoading = true;
    this.permissionsError = null;
    try {
      const p = await invoke<EffectivePermissions>("get_effective_permissions", { kind, name, subjectNamespace, namespace, groups });
      if (g === this.gen) this.permissions = p;
    } catch (err) {
      if (g === this.gen) {
        this.permissionsError = String(err);
        this.permissions = null;
      }
    } finally {
      if (g === this.gen) this.permissionsLoading = false;
    }
  }
}

export const rbacStore = new RbacStore();
