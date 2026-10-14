"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Button } from "@yld-cx/ui/components/ui/button";
export default function ErrorScreen({ reset }: { reset: () => void }) {
  return (
    <Card className="items-center text-center [&_h2]:text-xl [&_h3]:text-lg [&_p]:max-w-xl [&_p]:text-muted-foreground">
      <CardContent className="space-y-4">
        <h1>Page unavailable</h1>
        <p>The page could not be loaded. Try again.</p>
        <Button onClick={reset}>Try again</Button>
      </CardContent>
    </Card>
  );
}
