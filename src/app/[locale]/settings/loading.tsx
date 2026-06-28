import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="p-6 max-w-xl mx-auto">
      <Skeleton className="h-8 w-32 mb-2" />
      <Skeleton className="h-4 w-64 mb-8" />
      <div className="space-y-6">
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-10 rounded-md" />
      </div>
    </div>
  );
}
