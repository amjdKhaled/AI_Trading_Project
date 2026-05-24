import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-4xl font-mono font-bold text-muted-foreground mb-2">404</div>
      <p className="text-sm text-muted-foreground mb-4">Page not found</p>
      <Link href="/" className="text-xs text-primary hover:underline">Go to chart</Link>
    </div>
  );
}
