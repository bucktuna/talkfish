import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-[#d9d0c3] bg-white px-3 py-2 text-sm text-[#1c1915] placeholder:text-[#746c62] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0f5c4c]",
        className,
      )}
      {...props}
    />
  );
}
