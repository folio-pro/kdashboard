import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  onwarn(warning, handler) {
    // These are already addressed with svelte-ignore in the templates
    // (interactive spans nested inside buttons — can't use <button> there)
    if (warning.code === "a11y_click_events_have_key_events") return;
    handler(warning);
  },
};
