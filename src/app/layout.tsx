import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Header, { previewClass } from "@/components/Header";
import PreviewNote from "@/components/PreviewNote";
import Footer from "@/components/Footer";
import Providers from "@/components/Providers";
import NavProgress from "@/components/NavProgress";
import { IS_LIVE, PUBLIC_SITE_URL, X_HANDLE, X_LIVE } from "@/lib/config";
import { ABOUT, TAGLINE } from "@/lib/nav";

const silkscreen = localFont({
  variable: "--font-silkscreen",
  src: [
    { path: "../assets/fonts/Silkscreen-400.woff2", weight: "400" },
    { path: "../assets/fonts/Silkscreen-700.woff2", weight: "700" },
  ],
});
const grotesk = localFont({
  variable: "--font-grotesk",
  src: [{ path: "../assets/fonts/SpaceGrotesk-var.woff2", weight: "300 700" }],
});
const departure = localFont({
  variable: "--font-departure",
  preload: false,
  // Departure Mono (OFL): a pixel mono for numbers, labels and buttons; one file for every weight so the
  // browser never fakes a smeared bold on the pixel grid
  src: [{ path: "../assets/fonts/DepartureMono-Regular.woff2", weight: "300 800" }],
});

// positioning: see README
const description = `${TAGLINE} ${ABOUT}`;

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_SITE_URL),
  title: { default: `Exit Liquidity · ${TAGLINE.replace(/\.$/, "")}`, template: "%s · Exit Liquidity" },
  description,
  openGraph: {
    title: "Exit Liquidity",
    description,
    type: "website",
    siteName: "Exit Liquidity",
  },
  twitter: { card: "summary_large_image", ...(X_LIVE ? { site: `@${X_HANDLE}` } : {}), title: "Exit Liquidity", description },
};

export const viewport: Viewport = { themeColor: "#0a0c0b" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${silkscreen.variable} ${grotesk.variable} ${departure.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Providers>
          <NavProgress />
          <Header />
          {/* /exit only (the component checks the path): not sticky, it scrolls away with the page */}
          {!IS_LIVE && <PreviewNote className={previewClass} />}
          <main id="main">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
