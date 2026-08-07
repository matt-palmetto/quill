import type { Metadata } from 'next';
import './globals.css';
import { SideNav, PageContext } from '../components/SideNav';
import { ThemeToggle } from '../components/ThemeToggle';
import { currentViewer } from '../lib/authz';

export const metadata: Metadata = {
  title: 'Quill — Example Org',
  applicationName: 'Quill',
  description: 'Quill, the Example Org knowledge search console.',
};

// The console reads live upstreams (quill-api) — never cache pages.
export const dynamic = 'force-dynamic';

// Dark is the default brand experience: only an explicit saved 'light'
// preference switches themes (the OS color-scheme preference is ignored).
const themeBootstrap = `
(() => {
  try {
    const saved = localStorage.getItem('quill-console-theme');
    const theme = saved === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.colorScheme = 'dark';
  }
})();
`;

/**
 * Root layout — mounts the Charleston workspace shell around every page: an
 * ink sidebar (brand lockup, grouped nav, viewer identity chip) and a slim
 * top bar (page context on the left; theme toggle on the right). The viewer
 * identity comes from the CF-Access-verified headers middleware forwarded;
 * it is display-only here.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await currentViewer();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <div className="gw-shell">
          <SideNav viewer={viewer ? { email: viewer.email } : null} />
          <div className="gw-main">
            <header className="gw-top">
              <div className="gw-top__left">
                <PageContext />
              </div>
              <div className="gw-top__right">
                <ThemeToggle />
              </div>
            </header>
            <main className="gw-canvas">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
