import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden p-4 space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-3/4 rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-1/2 rounded-lg" />
      </div>
      <div className="border-t border-border p-4">
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </div>
  );
}
