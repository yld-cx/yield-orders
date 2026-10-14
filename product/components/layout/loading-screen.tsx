import { Skeleton } from "@yld-cx/ui/components/ui/skeleton";
export default function LoadingScreen() {
  return (
    <div role="status" className="my-8 space-y-4">
      <p className="text-sm text-muted-foreground">Loading yld.cx…</p>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
