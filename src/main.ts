import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { extensions } from "$lib/extensions";

// No registrations are made in the core bundle. Sealing now guarantees that
// any accidental attempt to register extensions after mount fails loudly.
extensions.seal();

const app = mount(App, {
  target: document.getElementById("app")!,
});

// Startup hooks run after mount so the UI is interactive immediately.
extensions.runStartupHooks().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Extension startup hook failed:", err);
});

export default app;
