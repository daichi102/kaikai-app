import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "家電回収・返却管理システム",
  description: "AQUA返品票のOCR確認と回収返却管理を行うシステム",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
