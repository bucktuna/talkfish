import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Talkfish",
  description: "A voice chess coach for the position on the board. Type or speak.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
