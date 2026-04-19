<script lang="ts">
  interface Props {
    label: string;
    value: string | number;
    color?: string;
  }

  let { label, value, color }: Props = $props();
</script>

<div class="flex items-center gap-2">
  <span class="text-xs text-[var(--text-dimmed)]">{label}</span>
  <span class="font-mono text-sm font-bold" style:color={color ?? 'var(--text-primary)'}>{value}</span>
</div>
