import { cn } from "@/lib/utils";

export function DashedSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "shrink-0 border-t border-dashed border-border",
        className
      )}
      {...props}
    />
  );
}
