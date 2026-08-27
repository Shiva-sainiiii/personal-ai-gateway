import "./globals.css";
import Navbar from "../components/Navbar.js";

export const metadata = {
  title: "Personal AI Gateway",
  description: "Admin panel for your personal AI gateway",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        {children}
      </body>
    </html>
  );
}
