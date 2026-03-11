import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";

import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap"
});

export const metadata: Metadata = {
  title: "Ahorcado de Oficina",
  description: "Mini juego web de ahorcado para jugar rapido con tu equipo."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className={spaceGrotesk.className}>{children}</body>
    </html>
  );
}
