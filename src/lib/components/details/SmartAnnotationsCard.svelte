<script lang="ts">
  import { ChevronDown, Globe, Network, ShieldCheck, GitBranch, Link, Ship, Box, BarChart3, Tag } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import { classifyAnnotations } from "./annotation-tools/registry";
  import type { AnnotationGroup, ToolConfig } from "./annotation-tools/types";
  import GenericToolGroup from "./annotation-tools/GenericToolGroup.svelte";
  import AmbassadorGroup from "./annotation-tools/AmbassadorGroup.svelte";
  import IstioGroup from "./annotation-tools/IstioGroup.svelte";
  import AnnotationsCard from "./AnnotationsCard.svelte";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";
  import type { IconComponent } from "$lib/actions/types";

  interface Props {
    annotations: Record<string, string>;
  }

  let { annotations }: Props = $props();

  let groups = $derived(classifyAnnotations(annotations));

  // Registry-driven component map (keeps registry.ts pure for testing)
  const RENDERER_MAP: Record<string, IconComponent> = {
    ambassador: AmbassadorGroup,
    istio: IstioGroup,
  };

  // Icon component map
  const ICON_MAP: Record<string, IconComponent> = {
    Globe, Network, ShieldCheck, GitBranch, Link, Ship, Box, BarChart3, Tag,
  };

  // Collapsibility: groups with >5 annotations are collapsible
  let collapsed = $state<Set<string>>(new Set());

  function getGroupId(group: AnnotationGroup): string {
    return group.tool?.id ?? "__other__";
  }

  function isCollapsible(group: AnnotationGroup): boolean {
    return Object.keys(group.annotations).length > 5;
  }

  function isExpanded(group: AnnotationGroup): boolean {
    return !collapsed.has(getGroupId(group));
  }
</script>

{#if Object.keys(annotations).length > 0}
  <div class="flex flex-col gap-3">
    {#each groups as group}
      {@const groupId = getGroupId(group)}
      {@const collapsible = isCollapsible(group)}
      {@const groupExpanded = isExpanded(group)}
      {@const count = Object.keys(group.annotations).length}

      {#if group.tool === null}
        <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <div class="flex items-center justify-between px-5 py-4">
            <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Other Annotations</h3>
            <span class="text-xs text-[var(--text-muted)]">{count}</span>
          </div>
          {#each Object.entries(group.annotations) as [key, value]}
            <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
              <span class="font-mono text-[11px] text-[var(--text-dimmed)]">{key}</span>
              <span class="truncate font-mono text-[11px] text-[var(--text-primary)]">{value}</span>
            </div>
          {/each}
        </div>
      {:else}
        <!-- Tool group -->
        <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {#if collapsible}
            <button
              class="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
              onclick={() => collapsed = toggleSetItem(collapsed, groupId)}
            >
              <div class="flex items-center gap-2.5">
                {#if group.tool.icon && ICON_MAP[group.tool.icon]}
                  {@const ToolIcon = ICON_MAP[group.tool.icon]}
                  <ToolIcon class="h-3.5 w-3.5 text-[var(--text-dimmed)]" />
                {/if}
                <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">{group.tool.name}</h3>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs text-[var(--text-muted)]">{count}</span>
                <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-dimmed)] transition-transform", groupExpanded && "rotate-180")} />
              </div>
            </button>
          {:else}
            <div class="flex items-center justify-between px-5 py-4">
              <div class="flex items-center gap-2.5">
                {#if group.tool.icon && ICON_MAP[group.tool.icon]}
                  {@const ToolIcon = ICON_MAP[group.tool.icon]}
                  <ToolIcon class="h-3.5 w-3.5 text-[var(--text-dimmed)]" />
                {/if}
                <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">{group.tool.name}</h3>
              </div>
              <span class="text-xs text-[var(--text-muted)]">{count}</span>
            </div>
          {/if}

          {#if !collapsible || groupExpanded}
            {#if RENDERER_MAP[group.tool.id]}
              {@const Renderer = RENDERER_MAP[group.tool.id]}
              <Renderer
                annotations={group.annotations}
                toolConfig={group.tool}
                shortKeys={group.shortKeys}
              />
            {:else}
              <GenericToolGroup
                annotations={group.annotations}
                toolConfig={group.tool}
                shortKeys={group.shortKeys}
              />
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}
