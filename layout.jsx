import "./globals.css"

export const metadata = {
  title: "DevHunt — Find elite engineers via open source signal",
  description:
    "DevHunt analyzes real GitHub work to surface elite but overlooked engineers. No forms. No surveys. Just signal from actual code.",
  openGraph: {
    title: "DevHunt",
    description: "Find elite engineers via open source signal",
    type: "website",
  },
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
