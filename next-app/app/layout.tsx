import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AeroRecon | WiFi Intelligence',
  description: 'Enterprise-grade ESP32 WiFi Reconnaissance & Geolocation Archiving platform.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
