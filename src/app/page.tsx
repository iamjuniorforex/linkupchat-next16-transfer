import { Hero, LandingNavbar } from '@/components/landing/Hero';
import { CTABanner, Experience, Features, Footer, PrivacySection } from '@/components/landing/Features';

export default function LandingPage() {
  return (
    <main id="main" className="relative min-h-[100dvh] overflow-x-hidden">
      <LandingNavbar />
      <Hero />
      <Features />
      <Experience />
      <PrivacySection />
      <CTABanner />
      <Footer />
    </main>
  );
}
