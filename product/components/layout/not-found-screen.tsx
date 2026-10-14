import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import Link from "next/link";
import { Button } from "@yld-cx/ui/components/ui/button";
export default function NotFoundScreen() {
  return (
    <Card className="items-center text-center [&_h2]:text-xl [&_h3]:text-lg [&_p]:max-w-xl [&_p]:text-muted-foreground">
      <CardContent className="space-y-4">
        <h1>Market not found</h1>
        <p>Check the network and token contract addresses.</p>
        <Button render={<Link href="/" />} nativeButton={false}>
          Return to Yield
        </Button>
      </CardContent>
    </Card>
  );
}
