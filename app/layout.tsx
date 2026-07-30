import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "我的暑假小伙伴",
    description: "完成暑假小任务，陪你的宠物一起长大。",
    applicationName: "我的暑假小伙伴",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: "暑假小伙伴",
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: [
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    },
    openGraph: {
      title: "我的暑假小伙伴",
      description: "每天完成一点点，和宠物一起快乐长大！",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "我的暑假小伙伴" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "我的暑假小伙伴",
      description: "每天完成一点点，和宠物一起快乐长大！",
      images: [`${origin}/og.png`],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#fff8e7",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
