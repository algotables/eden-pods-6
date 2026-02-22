import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/contexts/WalletContext";
import { AppProvider } from "@/contexts/AppContext";
import { Toaster } from "react-hot-toast";

export const metadata: Metadata = {
  title: "Eden Pods",
  description: "Throw a seed pod. Grow a food forest. On Algorand.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <WalletProvider>
          <AppProvider>
            {children}
            <Toaster
              position="top-center"
              toastOptions={{
                style: {
                  background: "#14532d",
                  color: "#f0fdf4",
                  borderRadius: "14px",
                  fontSize: "15px",
                },
              }}
            />
          </AppProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
