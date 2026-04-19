/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UNLOCK_PRO: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
