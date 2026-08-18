import { Globe, ShieldCheck, Zap } from 'lucide-react';
import Link from 'next/link';
import ThemeToggle from './theme-toggle';
import Image from 'next/image';

const features = [
  {
    icon: ShieldCheck,
    title: 'Bank-grade Security',
    text: '256-bit encryption and multi-layer protection',
  },
  {
    icon: Zap,
    title: 'Seamless & Fast',
    text: 'Quick access to your accounts and insights',
  },
  {
    icon: Globe,
    title: 'Anywhere, Anytime',
    text: 'Bank on the go with a beautiful experience',
  },
];

export function AuthShell({
  active,
  children,
}: {
  active: 'login' | 'register';
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-10 relative overflow-hidden">
        <div className="pointer-events-none absolute -right-24 top-1/4 size-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -left-24 bottom-0 size-72 rounded-full bg-primary/10 blur-3xl" />

        <div>
          <Image
            src="/neobank_logo_light.png"
            alt="NeoBank"
            width={140}
            height={36}
            className="h-9 w-auto dark:hidden"
            priority
          />
          <Image
            src="/neobank_logo_dark.png"
            alt="NeoBank"
            width={140}
            height={36}
            className="hidden h-9 w-auto dark:block"
            priority
          />
        </div>

        <div className="relative z-10 flex items-center gap-8">
          <div className="max-w-md space-y-6">
            <p>
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-xs">
                <ShieldCheck className="size-3.5 text-primary" />
                Secure, Private, Always Protected
              </span>
            </p>
            <h1 className="text-4xl font-bold">
              Welcome to <span className="text-primary">Neobank</span>
            </h1>
            <p className="text-muted-foreground">
              Experience secure, intelligent, and seamless banking built for the
              future. Your trusted partner in digital finance.
            </p>
            <ul className="space-y-6">
              {features.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex items-start gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <div>
                    <p className="font-medium">{title}</p>
                    <p className="text-sm text-muted-foreground">{text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="hidden xl:block shrink-0 w-2/5">
            <Image
              src="/hero_security_light.png"
              alt=""
              width={480}
              height={480}
              className="w-full dark:hidden"
              priority
            />
            <Image
              src="/hero_security_dark.png"
              alt=""
              width={480}
              height={480}
              className="hidden w-full dark:block"
              priority
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} NeoBank
          </p>
          <ThemeToggle />
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="flex rounded-lg bg-muted p-1">
            <Link
              href="/login"
              className={`flex-1 rounded-md px-4 py-2 text-center text-sm font-medium ${active === 'login' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'}`}
            >
              Login
            </Link>
            <Link
              href="/register"
              className={`flex-1 rounded-md px-4 py-2 text-center text-sm font-medium ${active === 'register' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'}`}
            >
              Register
            </Link>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
