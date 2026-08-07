// Mutating lifecycle of a dedicated deployment: apply, scale, revision
// history, rollback, restart, delete. Tests run in declaration order and
// share the deployment.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { Resource } from '../k8s/resource-types';
import type { RevisionInfo } from '../handlers/workload-ops';
import { dispatch, enabled, TEST_NAMESPACE, waitFor } from './setup';

const NAME = 'itest-deploy';
const IMAGE_V1 = 'nginx:1.27-alpine';
const IMAGE_V2 = 'nginx:1.28-alpine';

function deploymentYaml(image: string, replicas: number): string {
  return `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${NAME}
  namespace: ${TEST_NAMESPACE}
  labels:
    app: ${NAME}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${NAME}
  template:
    metadata:
      labels:
        app: ${NAME}
    spec:
      containers:
        - name: nginx
          image: ${image}
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { cpu: 50m, memory: 64Mi }
`;
}

async function getDeployment(): Promise<Resource> {
  return dispatch<Resource>('get_resource', {
    kind: 'Deployment',
    name: NAME,
    namespace: TEST_NAMESPACE,
  });
}

function deployedImage(dep: Resource): string {
  const spec = dep.spec as {
    template?: { spec?: { containers?: { image?: string }[] } };
  };
  return spec.template?.spec?.containers?.[0]?.image ?? '';
}

async function waitForRollout(expectedReplicas: number): Promise<void> {
  await waitFor(
    async () => {
      const dep = await getDeployment();
      const status = dep.status as { readyReplicas?: number; updatedReplicas?: number };
      return (
        status?.readyReplicas === expectedReplicas && status?.updatedReplicas === expectedReplicas
      );
    },
    { label: `${NAME} rollout to ${expectedReplicas} ready replicas` },
  );
}

describe('integration: workload operations', { skip: !enabled }, () => {
  after(async () => {
    // Best-effort cleanup so a failed run does not poison the next one.
    await dispatch('delete_resource', {
      kind: 'Deployment',
      name: NAME,
      namespace: TEST_NAMESPACE,
    }).catch(() => {});
  });

  test('apply_yaml creates the deployment and it rolls out', { timeout: 180_000 }, async () => {
    const result = await dispatch<string>('apply_yaml', { yaml: deploymentYaml(IMAGE_V1, 1) });
    assert.ok(result.includes('kind: Deployment'));
    await waitForRollout(1);
  });

  test('scale_workload changes replicas', { timeout: 180_000 }, async () => {
    await dispatch('scale_workload', {
      kind: 'Deployment',
      name: NAME,
      namespace: TEST_NAMESPACE,
      replicas: 2,
    });
    await waitForRollout(2);
  });

  test('a new image creates a second revision, sorted with current flag', { timeout: 180_000 }, async () => {
    await dispatch('apply_yaml', { yaml: deploymentYaml(IMAGE_V2, 2) });
    await waitForRollout(2);

    // The current flag lands on the first ReplicaSet still holding replicas,
    // so poll until the old one has fully scaled down.
    const revisions = await waitFor(
      async () => {
        const revs = await dispatch<RevisionInfo[]>('list_deployment_revisions', {
          name: NAME,
          namespace: TEST_NAMESPACE,
        });
        const current = revs.filter((r) => r.is_current);
        return revs.length >= 2 && current.length === 1 && current[0]!.images.includes(IMAGE_V2)
          ? revs
          : null;
      },
      { label: 'two deployment revisions with the new image current' },
    );

    const sorted = [...revisions].sort((a, b) => b.revision - a.revision);
    assert.deepEqual(
      revisions.map((r) => r.revision),
      sorted.map((r) => r.revision),
    );
  });

  test('rollback_deployment without a revision returns to the previous image', { timeout: 180_000 }, async () => {
    const message = await dispatch<string>('rollback_deployment', {
      name: NAME,
      namespace: TEST_NAMESPACE,
    });
    assert.match(message, /Rolled back to revision \d+/);

    await waitFor(
      async () => deployedImage(await getDeployment()) === IMAGE_V1,
      { label: `rollback to ${IMAGE_V1}` },
    );
  });

  test('rollback_deployment to a nonexistent revision rejects', async () => {
    await assert.rejects(
      dispatch('rollback_deployment', { name: NAME, namespace: TEST_NAMESPACE, revision: 9999 }),
      /Revision 9999 not found/,
    );
  });

  test('restart_workload stamps the pod template and rolls out', { timeout: 180_000 }, async () => {
    await dispatch('restart_workload', {
      kind: 'Deployment',
      name: NAME,
      namespace: TEST_NAMESPACE,
    });
    const dep = await getDeployment();
    const spec = dep.spec as {
      template?: { metadata?: { annotations?: Record<string, string> } };
    };
    assert.ok(spec.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt']);
    await waitForRollout(2);
  });

  test('scale_workload rejects invalid replicas', async () => {
    await assert.rejects(
      dispatch('scale_workload', {
        kind: 'Deployment',
        name: NAME,
        namespace: TEST_NAMESPACE,
        replicas: -1,
      }),
    );
  });

  test('delete_resource removes the deployment', { timeout: 180_000 }, async () => {
    await dispatch('delete_resource', {
      kind: 'Deployment',
      name: NAME,
      namespace: TEST_NAMESPACE,
    });
    await waitFor(
      async () => {
        try {
          await getDeployment();
          return false;
        } catch {
          return true;
        }
      },
      { label: `${NAME} deletion` },
    );
  });
});
