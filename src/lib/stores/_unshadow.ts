/**
 * Delete own data properties that shadow prototype $state accessors.
 *
 * When `useDefineForClassFields: true` (tsconfig), base-class field
 * declarations use [[DefineOwnProperty]] which creates own data properties
 * on the instance.  These shadow the prototype get/set accessors that
 * Svelte 5 compiles from `$state()`.  Deleting the own properties lets
 * the reactive accessors take effect.
 *
 * Walks the full prototype chain so a single call in the leaf constructor
 * covers accessors declared at any inheritance level.  Must be called in
 * the **leaf** subclass constructor — a base-class call runs before the
 * subclass field initializers and therefore cannot unshadow them.
 */
export function unshadowState(instance: object): void {
  for (const key of Object.getOwnPropertyNames(instance)) {
    let proto = Object.getPrototypeOf(instance);
    while (proto && proto !== Object.prototype) {
      if (Object.getOwnPropertyDescriptor(proto, key)?.get) {
        Reflect.deleteProperty(instance, key);
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
}
