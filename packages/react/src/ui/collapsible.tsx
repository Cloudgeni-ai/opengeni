import * as React from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

const Collapsible = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof CollapsiblePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>(function Collapsible({ ...props }, ref) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" ref={ref} {...props} />;
});

const CollapsibleTrigger = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>
>(function CollapsibleTrigger({ ...props }, ref) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" ref={ref} {...props} />
  );
});

const CollapsibleContent = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(function CollapsibleContent({ ...props }, ref) {
  return (
    <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" ref={ref} {...props} />
  );
});

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
