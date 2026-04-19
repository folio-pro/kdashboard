<script lang="ts">
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { AlertTriangle } from "lucide-svelte";

  interface Props {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel?: string;
    variant?: "destructive" | "default";
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    open,
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    variant = "destructive",
    onconfirm,
    oncancel,
  }: Props = $props();

  function handleOpenChange(value: boolean) {
    if (!value) oncancel();
  }
</script>

<Dialog {open} onOpenChange={handleOpenChange}>
  <DialogContent class="sm:max-w-[420px]">
    <DialogHeader>
      <div class="flex items-center gap-3">
        {#if variant === "destructive"}
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--status-failed)]/10">
            <AlertTriangle class="h-4.5 w-4.5 text-[var(--status-failed)]" />
          </div>
        {/if}
        <div class="flex flex-col gap-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription class="text-xs text-[var(--text-muted)]">{description}</DialogDescription>
        </div>
      </div>
    </DialogHeader>
    <DialogFooter class="mt-4">
      <Button variant="outline" size="sm" onclick={oncancel}>
        {cancelLabel}
      </Button>
      <Button
        variant={variant === "destructive" ? "destructive" : "default"}
        size="sm"
        onclick={onconfirm}
      >
        {confirmLabel}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
