import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { setKubeconfigPath } from '../k8s/client';
import { register, withCurrentContext } from './connection';

// Every test works on a temp kubeconfig via setKubeconfigPath — never the
// user's ~/.kube/config.
const KUBECONFIG = `# prod cluster — careful
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://prod.example.invalid:6443
  name: prod
- cluster:
    server: https://dev.example.invalid:6443
  name: dev
contexts:
- context:
    cluster: prod
    user: me
  name: prod   # the scary one
- context:
    cluster: dev
    user: me
  name: dev
current-context: prod # switched by kdashboard
preferences: {}
users:
- name: me
  user:
    token: "abc"
`;

let dir: string;
let file: string;
let handlers: HandlerMap;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdash-conn-'));
  file = path.join(dir, 'config');
  fs.writeFileSync(file, KUBECONFIG, { mode: 0o600 });
  setKubeconfigPath(file);
  handlers = new Map();
  register(handlers, {} as HandlerCtx);
});

afterEach(() => {
  setKubeconfigPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const switchContext = (context: string) => handlers.get('switch_context')!({ context }, {} as HandlerCtx);

describe('switch_context', () => {
  test('an unknown context rejects and leaves the file untouched', async () => {
    const before = fs.statSync(file);
    await expect(switchContext('nope')).rejects.toThrow('Context not found: nope');
    expect(fs.readFileSync(file, 'utf8')).toBe(KUBECONFIG);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });

  test('changes only the current-context value, keeping comments and formatting', async () => {
    await switchContext('dev');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      KUBECONFIG.replace('current-context: prod #', 'current-context: dev #'),
    );
    expect(await handlers.get('get_current_context')!({}, {} as HandlerCtx)).toBe('dev');
  });

  test('writes atomically and preserves the 0600 mode', async () => {
    await switchContext('dev');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['config']);
  });
});

describe('withCurrentContext', () => {
  test('replaces a quoted value in place', () => {
    expect(withCurrentContext("a: 1\ncurrent-context: 'x y'  # hi\n", 'dev')).toBe(
      'a: 1\ncurrent-context: dev  # hi\n',
    );
  });

  test('fills an empty value', () => {
    expect(withCurrentContext('current-context:\nb: 2\n', 'dev')).toBe('current-context: dev\nb: 2\n');
  });

  test('appends the key when absent', () => {
    expect(withCurrentContext('contexts: []', 'dev')).toBe('contexts: []\ncurrent-context: dev\n');
  });

  test('quotes names that would not round-trip as plain scalars', () => {
    const out = withCurrentContext('current-context: a\n', 'x # y');
    expect(out).toBe('current-context: "x # y"\n');
  });

  test('keeps long ARN-style names on one line', () => {
    const arn = `arn:aws:eks:eu-west-1:123456789012:cluster/${'x'.repeat(100)}`;
    expect(withCurrentContext('current-context: a\n', arn)).toBe(`current-context: ${arn}\n`);
  });
});
