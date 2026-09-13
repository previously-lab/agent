import { Skeleton } from "@/components/ui/skeleton";

/**
 * The settings skeleton. Its wrapper is COPIED FROM THE PAGE IT STANDS IN FOR
 * (`settings/page.tsx`: `p-6 max-w-3xl mx-auto pt-16`) and must stay identical
 * to it. It used to say `max-w-xl`, which is 128px narrower than the real
 * column — so the whole form shifted sideways the moment the data landed. A
 * skeleton that is the wrong width is worse than no skeleton: it moves the
 * thing it was supposed to be holding still.
 */
export default function Loading() {
  return (
    <div className="p-6 max-w-3xl mx-auto pt-16">
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
