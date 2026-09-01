<script lang="ts">
  import type { Snippet } from "svelte";
  import type { OpenGeniSvelteContext } from "../context";
  import OpenGeniContextBoundary from "./OpenGeniContextBoundary.svelte";

  let { context, children }: { context: OpenGeniSvelteContext; children?: Snippet } = $props();
</script>

<div class="og-root" data-og-component="session">
  {#key context.client}
    {#key context.workspaceId}
      {#key context.sessionClient}
        {#key context.goalClient}
          {#key context.lineageClient}
            {#key context.humanInputClient}
              {#key context.mcpApprovalPolicyClient}
                {#key context.fileAttachmentClient}
                  <OpenGeniContextBoundary {context} {children} />
                {/key}
              {/key}
            {/key}
          {/key}
        {/key}
      {/key}
    {/key}
  {/key}
</div>
