<script lang="ts">
  interface Props {
    label: string;
    value: string | number;
    valueColor?: string;
  }

  let { label, value, valueColor }: Props = $props();
</script>

<div class="flex flex-col gap-2.5 rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] p-5">
  <span class="text-xs font-medium text-[var(--text-muted)]">{label}</span>
  <span class="text-[28px] font-bold leading-none" style:color={valueColor ?? 'var(--text-primary)'}>{value}</span>
</div>
